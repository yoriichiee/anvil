import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import { Construct } from 'constructs';

export interface AnvilCertStackProps extends cdk.StackProps {
  domainName: string;
}

/**
 * us-east-1 only because CloudFront requires its viewer certificate there.
 * DNS for horvans.com lives at Hostinger (no Route 53 zone), so validation is manual:
 * while `cdk deploy AnvilCert` waits in CREATE_IN_PROGRESS, run scripts/cert-cname.ps1
 * to print the validation CNAME, add it at Hostinger, and the stack completes on its own.
 */
export class AnvilCertStack extends cdk.Stack {
  public readonly certificate: acm.Certificate;

  constructor(scope: Construct, id: string, props: AnvilCertStackProps) {
    super(scope, id, props);

    this.certificate = new acm.Certificate(this, 'Certificate', {
      domainName: props.domainName,
      validation: acm.CertificateValidation.fromDns(), // no hosted zone -> manual CNAME at Hostinger
      certificateName: 'anvil-site',
    });
    this.certificate.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);

    new cdk.CfnOutput(this, 'CertificateArn', {
      value: this.certificate.certificateArn,
      description: 'Pass to the Anvil stack: npx cdk deploy Anvil -c certArn=<this>',
    });
    new cdk.CfnOutput(this, 'DnsValidationCname', {
      value: `Run infra/scripts/cert-cname.ps1 (or: aws acm describe-certificate --region us-east-1 --certificate-arn <arn> --query Certificate.DomainValidationOptions[0].ResourceRecord) and add that CNAME at Hostinger for ${props.domainName}`,
      description: 'Where to get the ACM DNS validation CNAME (CloudFormation cannot output it directly)',
    });
  }
}
