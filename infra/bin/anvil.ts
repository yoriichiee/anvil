#!/usr/bin/env node
// Anvil CDK app. Two explicitly named stacks, nothing shared with stack "Hovarns".
//   AnvilCert  us-east-1      ACM certificate for CloudFront (the only us-east-1 resource)
//   Anvil      project Region S3 + CloudFront + HTTP API + Lambda + DynamoDB + KMS
// Context (cdk.json or -c):
//   anvil:region          project Region (alias: region), default ap-southeast-2
//   anvil:domainName      default anvil.horvans.com
//   anvil:certificateArn  (alias: certArn) us-east-1 cert ARN; empty = no alias, raw dXXXX.cloudfront.net only
//   anvil:apiDir          Lambda code dir (alias: apiDir), default ../api; stub used if index.mjs is missing
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { AnvilCertStack } from '../lib/cert-stack';
import { AnvilStack } from '../lib/anvil-stack';

const app = new cdk.App();

function ctx(...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = app.node.tryGetContext(k);
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
  }
  return undefined;
}

const region = ctx('region', 'anvil:region') ?? 'ap-southeast-2';
const domainName = ctx('domainName', 'anvil:domainName') ?? 'anvil.horvans.com';
const certificateArn = ctx('certArn', 'certificateArn', 'anvil:certificateArn');
const apiDir = path.resolve(__dirname, '..', ctx('apiDir', 'anvil:apiDir') ?? '../api');
const lambdaRuntime = ctx('lambdaRuntime', 'anvil:lambdaRuntime') ?? 'nodejs20.x';
if (lambdaRuntime !== 'nodejs20.x' && lambdaRuntime !== 'nodejs22.x') {
  throw new Error('lambdaRuntime must be nodejs20.x or nodejs22.x');
}
const account = process.env.CDK_DEFAULT_ACCOUNT; // undefined when synthesizing without credentials (fine)

// Project rule: regional resources (Lambda, API Gateway, DynamoDB, S3, KMS) live in the project Region only.
if (region === 'us-east-1') {
  throw new Error('Anvil stack must not be created in us-east-1 (project Region only). Pass -c region=<project Region>.');
}
if (!/^[a-z]{2}(-[a-z]+)+-\d$/.test(region)) {
  throw new Error(`Invalid region context: ${region}`);
}
if (certificateArn && !/^arn:aws:acm:us-east-1:\d{12}:certificate\/[0-9a-f-]{36}$/.test(certificateArn)) {
  throw new Error('certArn must be an ACM certificate ARN in us-east-1 (CloudFront requirement).');
}

new AnvilCertStack(app, 'AnvilCert', {
  stackName: 'AnvilCert',
  env: { account, region: 'us-east-1' },
  domainName,
  description: `Anvil: ACM certificate for ${domainName} (us-east-1, CloudFront only). DNS-validated at Hostinger.`,
});

new AnvilStack(app, 'Anvil', {
  stackName: 'Anvil',
  env: { account, region },
  domainName,
  certificateArn,
  apiDir,
  lambdaRuntime,
  description: 'Anvil: static site + /dl + /registry on S3/CloudFront, /api on HTTP API + Lambda, DynamoDB anvil-main. Isolated from stack Hovarns.',
});

cdk.Tags.of(app).add('Project', 'anvil');
