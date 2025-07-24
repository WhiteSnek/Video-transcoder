import { ReceiveMessageCommand, SQSClient, DeleteMessageCommand } from "@aws-sdk/client-sqs";
import { ECSClient, RunTaskCommand } from "@aws-sdk/client-ecs";
import type { S3Event } from "aws-lambda";
import * as dotenv from 'dotenv';
dotenv.config();

const AWS_ACCESS_KEY = process.env.AWS_ACCESS_KEY!
const AWS_SECRET_KEY = process.env.AWS_SECRET_KEY!
const AWS_REGION = process.env.AWS_REGION!
const QUEUE_URL = process.env.QUEUE_URL!
const TASK_DEFINITION = process.env.TASK_DEFINITION!
const CLUSTER = process.env.CLUSTER!
const INPUT_BUCKET = process.env.INPUT_BUCKET!
const OUTPUT_BUCKET = process.env.OUTPUT_BUCKET!


const client = new SQSClient({
  credentials: {
    accessKeyId: AWS_ACCESS_KEY,
    secretAccessKey: AWS_SECRET_KEY,
  },
  region: AWS_REGION,
});

const ecsClient = new ECSClient({
  credentials: {
    accessKeyId: AWS_ACCESS_KEY,
    secretAccessKey: AWS_SECRET_KEY,
  },
  region: AWS_REGION,
});

async function init() {
  const command = new ReceiveMessageCommand({
    QueueUrl:
    QUEUE_URL,
    MaxNumberOfMessages: 1,
    WaitTimeSeconds: 20,
  });
  while (true) {
    const { Messages } = await client.send(command);
    if (!Messages) {
      console.log("No messages in queue");
      continue;
    }

    try {
      for (const message of Messages) {
        const { MessageId, Body } = message;
        console.log("Message Recieved", { MessageId, Body });
        if (!Body) continue;
        // validate & Parse the event
        const event = JSON.parse(Body) as S3Event;
        // ignore the test event
        if ("Service" in event && "Event" in event) {
          if (event.Event === "s3:TestEvent"){
            await client.send(new DeleteMessageCommand({
                QueueUrl: QUEUE_URL,
                ReceiptHandle: message.ReceiptHandle
              }))
              continue;
          }
        }

        for (const record of event.Records) {
          const { s3 } = record;
          const {
            bucket,
            object: { key },
          } = s3;
          const decodedKey = decodeURIComponent(key);
          // spin the docker container
          const runTaskCommand = new RunTaskCommand({
            taskDefinition:TASK_DEFINITION,
            cluster: CLUSTER,
            launchType: "FARGATE",
            networkConfiguration: {
              awsvpcConfiguration: {
                assignPublicIp: "ENABLED",
                securityGroups: ["sg-02ebc4eb7f1fc7a4e"],
                subnets: [
                  "subnet-0cfb7a37a07f81ebc",
                  "subnet-06694e871a921dbde",
                  "subnet-07d4cf0d878e84a12",
                ],
              },
            },
            overrides: {
              containerOverrides: [
                {
                  name: "video-transcoder",
                  environment: [
                    { name: "INPUT_BUCKET", value: bucket.name },
                    { name: "OUTPUT_BUCKET", value: OUTPUT_BUCKET },
                    { name: "AWS_ACCESS_KEY", value: AWS_ACCESS_KEY},
                    { name: "AWS_SECRET_KEY", value: AWS_SECRET_KEY},
                    { name: "AWS_REGION", value: AWS_REGION},
                    { name: "KEY", value: decodedKey },
                  ],
                },
              ],
            },
          });
          await ecsClient.send(runTaskCommand);
          // delete the message
          await client.send(new DeleteMessageCommand({
            QueueUrl: process.env.QUEUE_URL!,
            ReceiptHandle: message.ReceiptHandle
          }))
        }
        
        
      }
    } catch (error) {
      console.log(error);
    }
  }
}

init();
