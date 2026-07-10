import json
import os
import boto3

ecs = boto3.client("ecs")

CLUSTER = os.environ["ECS_CLUSTER"]
TASK_DEFINITION = os.environ["TASK_DEFINITION"]
SUBNETS = os.environ["SUBNETS"].split(",")
SECURITY_GROUPS = os.environ["SECURITY_GROUPS"].split(",")
OUTPUT_BUCKET = os.environ["OUTPUT_BUCKET"]


def lambda_handler(event, context):
    for record in event.get("Records", []):
        try:
            # SQS body contains an S3 event
            sqs_body = json.loads(record["body"])

            for s3_record in sqs_body["Records"]:
                bucket = s3_record["s3"]["bucket"]["name"]
                key = s3_record["s3"]["object"]["key"]

                response = ecs.run_task(
                    cluster=CLUSTER,
                    taskDefinition=TASK_DEFINITION,
                    launchType="FARGATE",
                    networkConfiguration={
                        "awsvpcConfiguration": {
                            "subnets": SUBNETS,
                            "securityGroups": SECURITY_GROUPS,
                            "assignPublicIp": "ENABLED"
                        }
                    },
                    overrides={
                        "containerOverrides": [
                            {
                                "name": "video-transcoder",
                                "environment": [
                                    {
                                        "name": "INPUT_BUCKET",
                                        "value": bucket
                                    },
                                    {
                                        "name": "KEY",
                                        "value": key
                                    },
                                    {
                                        "name": "OUTPUT_BUCKET",
                                        "value": OUTPUT_BUCKET
                                    }
                                ]
                            }
                        ]
                    }
                )

                print(f"Started task for {key}")
                print(response)

        except Exception as e:
            print(f"Error processing record: {e}")
            raise

    return {
        "statusCode": 200,
        "body": json.dumps("Tasks started successfully")
    }