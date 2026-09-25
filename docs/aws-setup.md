# AWS Setup Guide

Step-by-step guide for deploying MergeWatch to your AWS account.

## Table of Contents

- [Prerequisites](#prerequisites)
- [IAM Permissions for Deployment](#iam-permissions-for-deployment)
- [Step 1: Configure AWS Credentials](#step-1-configure-aws-credentials)
- [Step 2: Create a GitHub App](#step-2-create-a-github-app)
- [Step 3: Store GitHub Credentials in SSM](#step-3-store-github-credentials-in-ssm)
- [Step 4: Deploy the Stack](#step-4-deploy-the-stack)
- [Step 5: Configure the GitHub App Webhook](#step-5-configure-the-github-app-webhook)
- [How IAM Roles Work (No API Keys Needed)](#how-iam-roles-work-no-api-keys-needed)
- [Deploying to a Custom AWS Account](#deploying-to-a-custom-aws-account)
- [Using an Existing VPC](#using-an-existing-vpc)
- [Troubleshooting](#troubleshooting)

---

## Prerequisites

Install the following tools before deploying:

### AWS CLI v2

```bash
# macOS
brew install awscli

# Linux
curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"
unzip awscliv2.zip && sudo ./aws/install

# Verify
aws --version
```

### AWS SAM CLI

```bash
# macOS
brew install aws-sam-cli

# Linux
pip install aws-sam-cli

# Verify
sam --version
```

### Node.js 20.x

```bash
# Using nvm (recommended)
nvm install 20
nvm use 20

# Verify
node --version  # Should output v20.x.x
```

---

## IAM Permissions for Deployment

The IAM user or role running the deployment needs permissions to create and manage the following AWS resources. You can either use an admin role or create a scoped-down deployment policy.

### Option A: Admin Access (Simplest)

Attach the `AdministratorAccess` managed policy to your deployment user/role. This is the easiest option for personal accounts or initial setup.

### Option B: Scoped Deployment Policy (Recommended for Teams)

Create a custom IAM policy with these permissions:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "CloudFormation",
      "Effect": "Allow",
      "Action": [
        "cloudformation:CreateStack",
        "cloudformation:UpdateStack",
        "cloudformation:DeleteStack",
        "cloudformation:DescribeStacks",
        "cloudformation:DescribeStackEvents",
        "cloudformation:GetTemplate",
        "cloudformation:ListStackResources",
        "cloudformation:CreateChangeSet",
        "cloudformation:DescribeChangeSet",
        "cloudformation:ExecuteChangeSet",
        "cloudformation:DeleteChangeSet"
      ],
      "Resource": "arn:aws:cloudformation:*:*:stack/mergewatch*/*"
    },
    {
      "Sid": "Lambda",
      "Effect": "Allow",
      "Action": [
        "lambda:CreateFunction",
        "lambda:UpdateFunctionCode",
        "lambda:UpdateFunctionConfiguration",
        "lambda:DeleteFunction",
        "lambda:GetFunction",
        "lambda:GetFunctionConfiguration",
        "lambda:AddPermission",
        "lambda:RemovePermission",
        "lambda:TagResource",
        "lambda:ListTags"
      ],
      "Resource": "arn:aws:lambda:*:*:function:mergewatch-*"
    },
    {
      "Sid": "APIGateway",
      "Effect": "Allow",
      "Action": [
        "apigateway:POST",
        "apigateway:GET",
        "apigateway:PUT",
        "apigateway:DELETE",
        "apigateway:PATCH"
      ],
      "Resource": "arn:aws:apigateway:*::/apis*"
    },
    {
      "Sid": "DynamoDB",
      "Effect": "Allow",
      "Action": [
        "dynamodb:CreateTable",
        "dynamodb:UpdateTable",
        "dynamodb:DeleteTable",
        "dynamodb:DescribeTable",
        "dynamodb:TagResource"
      ],
      "Resource": "arn:aws:dynamodb:*:*:table/mergewatch-*"
    },
    {
      "Sid": "IAM",
      "Effect": "Allow",
      "Action": [
        "iam:CreateRole",
        "iam:DeleteRole",
        "iam:GetRole",
        "iam:PutRolePolicy",
        "iam:DeleteRolePolicy",
        "iam:AttachRolePolicy",
        "iam:DetachRolePolicy",
        "iam:PassRole",
        "iam:TagRole"
      ],
      "Resource": "arn:aws:iam::*:role/mergewatch-*"
    },
    {
      "Sid": "SSM",
      "Effect": "Allow",
      "Action": [
        "ssm:PutParameter",
        "ssm:GetParameter",
        "ssm:DeleteParameter"
      ],
      "Resource": "arn:aws:ssm:*:*:parameter/mergewatch/*"
    },
    {
      "Sid": "S3DeploymentBucket",
      "Effect": "Allow",
      "Action": [
        "s3:CreateBucket",
        "s3:PutObject",
        "s3:GetObject",
        "s3:ListBucket"
      ],
      "Resource": [
        "arn:aws:s3:::aws-sam-cli-managed-default-*",
        "arn:aws:s3:::aws-sam-cli-managed-default-*/*"
      ]
    },
    {
      "Sid": "CloudWatchLogs",
      "Effect": "Allow",
      "Action": [
        "logs:CreateLogGroup",
        "logs:DeleteLogGroup",
        "logs:PutRetentionPolicy"
      ],
      "Resource": "arn:aws:logs:*:*:log-group:/aws/lambda/mergewatch-*"
    }
  ]
}
```

---

## Step 1: Configure AWS Credentials

```bash
# Interactive setup (enter your Access Key ID, Secret Key, and region)
aws configure

# Verify your identity
aws sts get-caller-identity
```

You should see output like:

```json
{
  "UserId": "AIDAEXAMPLE",
  "Account": "123456789012",
  "Arn": "arn:aws:iam::123456789012:user/your-username"
}
```

---

## Step 2: Create a GitHub App

1. Go to [GitHub App settings](https://github.com/settings/apps/new)
2. Fill in the form:
   - **App name**: `MergeWatch` (or your preferred name)
   - **Homepage URL**: Your repo URL
   - **Webhook URL**: Leave blank for now (we'll fill this after deployment)
   - **Webhook secret**: Generate a strong secret (`openssl rand -hex 32`)
3. Set permissions:
   - **Pull requests**: Read & Write
   - **Contents**: Read & Write (write is used only to resolve review threads; grant Read-only instead if you prefer, and thread resolution is skipped)
   - **Metadata**: Read-only
4. Subscribe to events:
   - **Pull request**
5. Click **Create GitHub App**
6. Note the **App ID** from the settings page
7. Generate a **private key** and save the `.pem` file

---

## Step 3: Store GitHub Credentials in SSM

Run the setup script, which will prompt you for each value:

```bash
# Make the script executable
chmod +x scripts/setup-ssm.sh

# Run for your target environment
./scripts/setup-ssm.sh          # production (default)
./scripts/setup-ssm.sh staging  # staging
./scripts/setup-ssm.sh dev      # development
```

The script stores three parameters in SSM Parameter Store as encrypted `SecureString` values:

| Parameter Path | Description |
|---|---|
| `/mergewatch/{stage}/github-app-id` | Numeric App ID |
| `/mergewatch/{stage}/github-private-key` | PEM private key contents |
| `/mergewatch/{stage}/github-webhook-secret` | Webhook secret string |

You can verify they were stored correctly:

```bash
aws ssm get-parameter \
  --name /mergewatch/prod/github-app-id \
  --with-decryption \
  --query 'Parameter.Value' \
  --output text
```

---

## Step 4: Deploy the Stack

```bash
# Make scripts executable
chmod +x scripts/deploy.sh

# Deploy to production
./scripts/deploy.sh

# Or deploy to a specific environment
./scripts/deploy.sh dev
./scripts/deploy.sh staging

# Or run guided setup (interactive, great for first time)
./scripts/deploy.sh --guided
```

After deployment, the script prints the **Webhook URL**. Copy this URL.

---

## Step 5: Configure the GitHub App Webhook

1. Go to your GitHub App settings: `https://github.com/settings/apps/YOUR-APP-NAME`
2. In the **Webhook** section:
   - **Webhook URL**: Paste the URL from Step 4
   - **Content type**: `application/json`
   - **Secret**: The same secret you used in Step 3
3. Click **Save changes**
4. Install the app on a repository to test it

---

## How IAM Roles Work (No API Keys Needed)

MergeWatch uses AWS IAM roles instead of hardcoded API keys. Here's how it works:

### The Problem with API Keys

Traditional approaches store AWS access keys in environment variables or config files:

```
AWS_ACCESS_KEY_ID=AKIA...     # DON'T DO THIS
AWS_SECRET_ACCESS_KEY=wJal... # DON'T DO THIS
```

This is insecure because:
- Keys can leak in source control, logs, or error messages
- Keys don't expire automatically
- Rotating keys requires redeployment

### How IAM Roles Solve This

Instead of long-lived credentials, MergeWatch Lambda functions use an **IAM execution role**. Here's the flow:

1. **At deploy time**: CloudFormation creates an IAM role (`mergewatch-lambda-role-{stage}`) with specific permissions for DynamoDB, Bedrock, SSM, and CloudWatch.

2. **At runtime**: When Lambda invokes a function, it automatically provides temporary credentials (via the instance metadata service) that the AWS SDK picks up. These credentials:
   - Are rotated automatically (every ~1 hour)
   - Are scoped to exactly the permissions in the role
   - Never appear in code, logs, or environment variables

3. **In code**: The AWS SDK detects the role credentials automatically. No configuration needed:

```typescript
// This "just works" in Lambda — no credentials to configure
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
const client = new DynamoDBClient({});  // Credentials auto-detected
```

### Instance Profiles vs. IAM Roles

- An **IAM role** defines a set of permissions.
- An **instance profile** is a container for an IAM role that allows EC2 instances (and Lambda functions) to assume the role.
- AWS SAM/CloudFormation handles the instance profile creation automatically when you assign a role to a Lambda function.

You never need to create or manage instance profiles manually for Lambda.

---

## Deploying to a Custom AWS Account

### Using a Different AWS Account

```bash
# Option 1: Use a named AWS CLI profile
export AWS_PROFILE=my-other-account
./scripts/deploy.sh

# Option 2: Use environment variables
export AWS_ACCESS_KEY_ID=your-key
export AWS_SECRET_ACCESS_KEY=your-secret
export AWS_DEFAULT_REGION=us-west-2
./scripts/deploy.sh
```

### Using a Different Region

Edit `infra/samconfig.toml` and change the `region` value:

```toml
[default.deploy.parameters]
region = "eu-west-1"  # Change to your preferred region
```

Make sure Amazon Bedrock is available in your chosen region. Check the [Bedrock region availability](https://docs.aws.amazon.com/bedrock/latest/userguide/bedrock-regions.html).

### Using AWS SSO / IAM Identity Center

```bash
# Configure SSO
aws configure sso

# Log in
aws sso login --profile your-sso-profile

# Deploy with the SSO profile
export AWS_PROFILE=your-sso-profile
./scripts/deploy.sh
```

### Cross-Account Deployment with AssumeRole

If you deploy from a CI/CD account into a workload account:

```bash
# Assume a role in the target account
eval $(aws sts assume-role \
  --role-arn arn:aws:iam::TARGET_ACCOUNT:role/DeploymentRole \
  --role-session-name mergewatch-deploy \
  --query 'Credentials.[AccessKeyId,SecretAccessKey,SessionToken]' \
  --output text | awk '{print "export AWS_ACCESS_KEY_ID="$1" AWS_SECRET_ACCESS_KEY="$2" AWS_SESSION_TOKEN="$3}')

# Deploy to the target account
./scripts/deploy.sh
```

---

## Using an Existing VPC

By default, MergeWatch Lambda functions run without a VPC (they access AWS services and GitHub via the public internet). This is simpler and has lower latency.

If your organization requires Lambda functions to run inside a VPC (e.g., for compliance or to access private resources), add VPC configuration to the SAM template.

### Step 1: Add VPC Parameters

Add these parameters to `infra/template.yaml`:

```yaml
Parameters:
  # ... existing parameters ...

  VpcEnabled:
    Type: String
    Default: 'false'
    AllowedValues: ['true', 'false']
    Description: Whether to deploy Lambda functions inside a VPC

  VpcSubnetIds:
    Type: CommaDelimitedList
    Default: ''
    Description: Comma-separated list of private subnet IDs

  VpcSecurityGroupIds:
    Type: CommaDelimitedList
    Default: ''
    Description: Comma-separated list of security group IDs
```

### Step 2: Add VPC Config to Lambda Functions

Add a `VpcConfig` to each Lambda function:

```yaml
WebhookHandler:
  Type: AWS::Serverless::Function
  Properties:
    # ... existing properties ...
    VpcConfig:
      SubnetIds: !If [UseVpc, !Ref VpcSubnetIds, !Ref 'AWS::NoValue']
      SecurityGroupIds: !If [UseVpc, !Ref VpcSecurityGroupIds, !Ref 'AWS::NoValue']
```

### Step 3: Add a Condition

```yaml
Conditions:
  UseVpc: !Equals [!Ref VpcEnabled, 'true']
```

### Step 4: Add VPC Permissions to the IAM Role

Add these actions to the `LambdaExecutionRole`:

```yaml
- Effect: Allow
  Action:
    - ec2:CreateNetworkInterface
    - ec2:DescribeNetworkInterfaces
    - ec2:DeleteNetworkInterface
  Resource: '*'
```

### Step 5: Ensure Internet Access

Lambda functions in a VPC need a **NAT Gateway** to access the internet (for GitHub API and Bedrock calls). Make sure your VPC has:

- **Private subnets** with route tables pointing to a NAT Gateway
- **NAT Gateway** in a public subnet with an Elastic IP
- **VPC Endpoints** (optional, but recommended for DynamoDB and SSM to reduce NAT costs):
  - `com.amazonaws.{region}.dynamodb` (Gateway endpoint, free)
  - `com.amazonaws.{region}.ssm` (Interface endpoint)
  - `com.amazonaws.{region}.bedrock-runtime` (Interface endpoint)

### Deploy with VPC

```bash
sam deploy \
  --parameter-overrides \
    VpcEnabled=true \
    VpcSubnetIds=subnet-abc123,subnet-def456 \
    VpcSecurityGroupIds=sg-xyz789
```

---

## Troubleshooting

### "Unable to assume role" Error

The Lambda execution role may not have been created properly. Check:

```bash
aws iam get-role --role-name mergewatch-lambda-role-prod
```

### "Access Denied" on Bedrock

1. Make sure you've enabled the Bedrock model in your AWS account:
   - Go to the [Bedrock console](https://console.aws.amazon.com/bedrock/)
   - Navigate to **Model access**
   - Request access to the Claude models

2. Verify the IAM role has the `AmazonBedrockFullAccess` policy:

```bash
aws iam list-attached-role-policies --role-name mergewatch-lambda-role-prod
```

### Lambda Timeout Errors

If the ReviewAgent function is timing out:
- Check CloudWatch Logs for the specific error
- Consider increasing the timeout in `template.yaml` (max 900 seconds)
- For very large PRs, the diff may need to be chunked

### SSM Parameter Not Found

Verify parameters exist and the Lambda role has SSM access:

```bash
# List all MergeWatch parameters
aws ssm get-parameters-by-path \
  --path /mergewatch/prod/ \
  --recursive \
  --query 'Parameters[].Name'
```

### Webhook Not Receiving Events

1. Check the GitHub App's **Advanced** tab for delivery logs
2. Verify the webhook URL matches the API Gateway endpoint
3. Check API Gateway logs in CloudWatch

### Viewing Lambda Logs

```bash
# Tail WebhookHandler logs
sam logs --name mergewatch-webhook-prod --tail

# Tail ReviewAgent logs
sam logs --name mergewatch-review-agent-prod --tail
```
