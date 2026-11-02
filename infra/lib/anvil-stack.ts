import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { Construct } from 'constructs';

export interface AnvilStackProps extends cdk.StackProps {
  domainName: string;
  /** us-east-1 ACM ARN from stack AnvilCert. Omit to serve on the raw dXXXX.cloudfront.net domain only. */
  certificateArn?: string;
  /** Directory holding the API Lambda (entry index.mjs, export handler). */
  apiDir: string;
  /**
   * Lambda runtime. Default nodejs20.x per the launch plan. NOTE: AWS deprecated nodejs20.x on 2026-04-30;
   * creation is blocked from 2027-02-01 and updates from 2027-03-03. Pass -c lambdaRuntime=nodejs22.x to move.
   */
  lambdaRuntime?: 'nodejs20.x' | 'nodejs22.x';
}

/** SSM SecureString parameter NAMES. Referenced only; the founder creates the values out of band. */
export const SSM_PARAMS = { github: '/anvil/github', anthropic: '/anvil/anthropic' } as const;

const LOG_RETENTION = logs.RetentionDays.TWO_WEEKS;

// Vendored scripts are served from the site itself ('self'); nothing is loaded from third-party CDNs.
// Google Fonts is the only allowed external style/font origin.
const CSP_SITE = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "frame-src 'self'",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  'upgrade-insecure-requests',
].join('; ');

// /demo-app/* is the deliberately-buggy sample app; the /demo replay may embed it in an iframe on the same origin.
const CSP_DEMO_APP = CSP_SITE.replace("frame-ancestors 'none'", "frame-ancestors 'self'");

// Rewrites pretty URLs to S3 keys: /x -> /x/index.html, /x/ -> /x/index.html, / -> /index.html.
// Paths whose last segment has a dot (assets, /install.sh) and anything under /registry/ pass through.
// /dl/* and /api/* behaviors do not run this function at all.
const INDEX_REWRITE_FN = `
function handler(event) {
  var req = event.request;
  var uri = req.uri;
  if (uri.endsWith('/')) {
    req.uri = uri + 'index.html';
  } else {
    var last = uri.substring(uri.lastIndexOf('/') + 1);
    if (last.indexOf('.') === -1 && uri.indexOf('/dl/') !== 0 && uri.indexOf('/registry/') !== 0) {
      // Redirect /demo -> /demo/ (not a silent rewrite): the site uses relative URLs (run.json, shots/, ../assets/)
      // so it also works on the GitHub Pages fallback, and those only resolve correctly under the trailing slash.
      var qs = [];
      var q = req.querystring || {};
      for (var k in q) { if (q[k] && q[k].value !== undefined) { qs.push(k + '=' + q[k].value); } }
      return { statusCode: 301, statusDescription: 'Moved Permanently',
        headers: { location: { value: uri + '/' + (qs.length ? '?' + qs.join('&') : '') }, 'cache-control': { value: 'max-age=3600' } } };
    }
  }
  return req;
}
`.trim();

export class AnvilStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AnvilStackProps) {
    super(scope, id, props);

    // ---------- Storage: private, versioned site bucket (served only through CloudFront OAC) ----------
    const siteBucket = new s3.Bucket(this, 'SiteBucket', {
      bucketName: `anvil-site-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true, // a bad tarball or page can be rolled back
      lifecycleRules: [
        { id: 'expire-old-versions', noncurrentVersionExpiration: cdk.Duration.days(90), noncurrentVersionsToRetain: 5 },
        { id: 'abort-mpu', abortIncompleteMultipartUploadAfter: cdk.Duration.days(7) },
      ],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ---------- Data: DynamoDB (sessions, credits, rate counters) + KMS (GitHub tokens) ----------
    const table = new dynamodb.Table(this, 'MainTable', {
      tableName: 'anvil-main',
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const tokenKey = new kms.Key(this, 'TokenKey', {
      description: 'Anvil: envelope key for GitHub user tokens stored in anvil-main',
      enableKeyRotation: true,
      alias: 'alias/anvil-github-tokens',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ---------- API: one Node 20 Lambda behind an HTTP API (throttled in place of WAF) ----------
    const realApi = fs.existsSync(path.join(props.apiDir, 'index.mjs'));
    const codeDir = realApi ? props.apiDir : path.join(__dirname, '..', 'lambda-stub');
    if (!realApi) {
      cdk.Annotations.of(this).addInfo(`api/index.mjs not found at ${props.apiDir}; using lambda-stub (503 on /api/*).`);
    }

    const apiLogs = new logs.LogGroup(this, 'ApiFnLogs', {
      logGroupName: '/aws/lambda/anvil-api',
      retention: LOG_RETENTION,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const apiFn = new lambda.Function(this, 'ApiFn', {
      functionName: 'anvil-api',
      runtime: props.lambdaRuntime === 'nodejs22.x' ? lambda.Runtime.NODEJS_22_X : lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(codeDir, {
        exclude: ['**/*.test.mjs', 'test/**', '.env', '.env.*', '**/*.pem', '**/*.key', '.git/**', 'README.md'],
      }),
      memorySize: 256,
      timeout: cdk.Duration.seconds(25), // HTTP API integration limit is 30 s
      logGroup: apiLogs,
      environment: {
        NODE_OPTIONS: '--enable-source-maps',
        ANVIL_TABLE: table.tableName,
        ANVIL_KMS_KEY_ID: tokenKey.keyArn,
        ANVIL_SSM_GITHUB: SSM_PARAMS.github,
        ANVIL_SSM_ANTHROPIC: SSM_PARAMS.anthropic,
        ANVIL_PUBLIC_ORIGIN: props.certificateArn ? `https://${props.domainName}` : '',
        ANVIL_AI_DAILY_CAP: '200',
        ANVIL_AI_USER_MONTHLY_CAP: '3',
      },
      description: realApi ? 'Anvil hosted API (/api/*)' : 'Anvil hosted API STUB (503) - api/index.mjs missing at synth',
    });
    table.grantReadWriteData(apiFn);
    tokenKey.grantEncryptDecrypt(apiFn);
    apiFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: Object.values(SSM_PARAMS).map((name) =>
        `arn:${this.partition}:ssm:${this.region}:${this.account}:parameter${name}`),
    }));
    // SecureString values use the AWS-managed aws/ssm key; GetParameter WithDecryption needs no extra grant.

    const httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      apiName: 'anvil-api',
      description: 'Anvil /api/* (reached through CloudFront)',
      createDefaultStage: true,
    });
    const integration = new HttpLambdaIntegration('ApiFnIntegration', apiFn, {
      payloadFormatVersion: apigwv2.PayloadFormatVersion.VERSION_2_0,
    });
    httpApi.addRoutes({ path: '/api/{proxy+}', methods: [apigwv2.HttpMethod.ANY], integration });
    httpApi.addRoutes({ path: '/api', methods: [apigwv2.HttpMethod.ANY], integration });

    const accessLogs = new logs.LogGroup(this, 'ApiAccessLogs', {
      logGroupName: '/anvil/http-api-access',
      retention: LOG_RETENTION,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const cfnStage = httpApi.defaultStage!.node.defaultChild as apigwv2.CfnStage;
    cfnStage.defaultRouteSettings = { throttlingRateLimit: 10, throttlingBurstLimit: 20 };
    cfnStage.accessLogSettings = {
      destinationArn: accessLogs.logGroupArn,
      format: JSON.stringify({
        requestId: '$context.requestId', ip: '$context.identity.sourceIp', time: '$context.requestTime',
        method: '$context.httpMethod', path: '$context.path', status: '$context.status',
        latency: '$context.responseLatency', err: '$context.integrationErrorMessage',
      }),
    };

    // ---------- Edge: CloudFront (no WAF, no Lambda@Edge) ----------
    const indexRewrite = new cloudfront.Function(this, 'IndexRewrite', {
      functionName: 'anvil-index-rewrite',
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(INDEX_REWRITE_FN),
      comment: 'Anvil: /x -> /x/index.html',
    });

    const securityHeaders = (name: string, csp: string, frame: cloudfront.HeadersFrameOption) =>
      new cloudfront.ResponseHeadersPolicy(this, `${name}Headers`, {
        responseHeadersPolicyName: `anvil-${name.toLowerCase()}-headers`,
        comment: `Anvil security headers (${name})`,
        securityHeadersBehavior: {
          contentSecurityPolicy: { contentSecurityPolicy: csp, override: true },
          strictTransportSecurity: { accessControlMaxAge: cdk.Duration.days(365), includeSubdomains: true, override: true },
          contentTypeOptions: { override: true },
          frameOptions: { frameOption: frame, override: true },
          referrerPolicy: { referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN, override: true },
        },
        customHeadersBehavior: {
          customHeaders: [
            { header: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()', override: true },
            { header: 'Cross-Origin-Opener-Policy', value: 'same-origin', override: true },
          ],
        },
        removeHeaders: ['Server', 'X-Amz-Server-Side-Encryption', 'X-Amz-Version-Id'],
      });
    const siteHeaders = securityHeaders('Site', CSP_SITE, cloudfront.HeadersFrameOption.DENY);
    const demoAppHeaders = securityHeaders('DemoApp', CSP_DEMO_APP, cloudfront.HeadersFrameOption.SAMEORIGIN);

    // HTML/pages: short cache (origin Cache-Control set by deploy-site.ps1 wins within these bounds).
    const shortCache = new cloudfront.CachePolicy(this, 'ShortCache', {
      cachePolicyName: 'anvil-short',
      comment: 'Anvil pages, registry, installers: 5 min default',
      minTtl: cdk.Duration.seconds(0),
      defaultTtl: cdk.Duration.minutes(5),
      maxTtl: cdk.Duration.days(1),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    });
    // /dl/*: versioned tarballs are immutable. SHA256SUMS is uploaded with max-age=300 and invalidated on publish.
    const longCache = new cloudfront.CachePolicy(this, 'LongCache', {
      cachePolicyName: 'anvil-dl-long',
      comment: 'Anvil /dl/*: 1 year default (pinned versions)',
      minTtl: cdk.Duration.seconds(0),
      defaultTtl: cdk.Duration.days(365),
      maxTtl: cdk.Duration.days(365),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    });

    const s3Origin = origins.S3BucketOrigin.withOriginAccessControl(siteBucket, {
      originAccessLevels: [cloudfront.AccessLevel.READ],
    });
    const apiOrigin = new origins.HttpOrigin(`${httpApi.apiId}.execute-api.${this.region}.${this.urlSuffix}`, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
      originSslProtocols: [cloudfront.OriginSslPolicy.TLS_V1_2],
      readTimeout: cdk.Duration.seconds(30),
    });

    const pageFnAssoc = [{ function: indexRewrite, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }];

    const certificate = props.certificateArn
      ? acm.Certificate.fromCertificateArn(this, 'SiteCert', props.certificateArn)
      : undefined;

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: 'Anvil site (anvil.horvans.com) - separate from Hovarns',
      ...(certificate
        ? { domainNames: [props.domainName], certificate, minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021 }
        : {}),
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_ALL,
      defaultRootObject: 'index.html',
      enableIpv6: true,
      defaultBehavior: {
        origin: s3Origin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachePolicy: shortCache,
        responseHeadersPolicy: siteHeaders,
        functionAssociations: pageFnAssoc,
        compress: true,
      },
      additionalBehaviors: {
        '/api/*': {
          origin: apiOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          responseHeadersPolicy: siteHeaders,
          compress: true,
        },
        '/dl/*': {
          origin: s3Origin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
          cachePolicy: longCache,
          responseHeadersPolicy: siteHeaders,
          compress: false, // serve the tarball byte-for-byte so SHA256SUMS always matches
        },
        '/demo-app/*': {
          origin: s3Origin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
          cachePolicy: shortCache,
          responseHeadersPolicy: demoAppHeaders,
          functionAssociations: pageFnAssoc,
          compress: true,
        },
      },
    });

    // ---------- Outputs (scripts/*.ps1 read these by OutputKey) ----------
    const out = (key: string, value: string, description: string) => new cdk.CfnOutput(this, key, { value, description });
    out('SiteBucketName', siteBucket.bucketName, 'Anvil site bucket (deploy-site.ps1 / publish-dl.ps1 target)');
    out('DistributionId', distribution.distributionId, 'Anvil CloudFront distribution (invalidations go here only)');
    out('DistributionDomainName', distribution.distributionDomainName, 'Hostinger CNAME target for anvil (fallback link if DNS stalls)');
    out('SiteUrl', certificate ? `https://${props.domainName}` : `https://${distribution.distributionDomainName}`, 'Public URL');
    out('HttpApiEndpoint', httpApi.apiEndpoint, 'Direct HTTP API endpoint (normally reached via CloudFront /api/*)');
    out('TableName', table.tableName, 'DynamoDB table');
    out('TokenKeyArn', tokenKey.keyArn, 'KMS key for GitHub tokens');
    out('ApiMode', realApi ? 'real' : 'stub', 'Whether api/index.mjs was found at synth time');
    out('SsmParameterNames', `${SSM_PARAMS.github},${SSM_PARAMS.anthropic}`, 'Create these SecureStrings yourself (values never in IaC)');
  }
}
