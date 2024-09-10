import { ReceiveMessageCommand, SQSClient, DeleteMessageCommand } from "@aws-sdk/client-sqs";
import { ECSClient, RunTaskCommand } from "@aws-sdk/client-ecs";
import type { S3Event } from "aws-lambda";
import * as dotenv from 'dotenv';
dotenv.config();

const client = new SQSClient({
  credentials: {
    accessKeyId: process.env.ACCESS_KEY_ID!,
    secretAccessKey: process.env.SECRET_ACCESS_KEY!,
  },
  region: "us-east-1",
});

const ecsClient = new ECSClient({
  credentials: {
    accessKeyId: process.env.ACCESS_KEY_ID!,
    secretAccessKey: process.env.SECRET_ACCESS_KEY!,
  },
  region: "us-east-1",
});

async function init() {
  const command = new ReceiveMessageCommand({
    QueueUrl:
    process.env.QUEUE_URL!,
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
                QueueUrl: process.env.QUEUE_URL!,
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
          // spin the docker container
          const runTaskCommand = new RunTaskCommand({
            taskDefinition:
            process.env.TASK_DEFINITION!,
            cluster: process.env.CLUSTER!,
            launchType: "FARGATE",
            networkConfiguration: {
              awsvpcConfiguration: {
                assignPublicIp: "ENABLED",
                securityGroups: ["sg-012ace9f347e8f965"],
                subnets: [
                  "subnet-07d39fd692b4bb355",
                  "subnet-07646b478bcd22120",
                  "subnet-08983cded8668d141",
                  "subnet-02b1e92372ec9bfb6",
                  "subnet-0608709ffac542ce4",
                  "subnet-0448a81fff3335f3a",
                ],
              },
            },
            overrides: {
              containerOverrides: [
                {
                  name: "video-transcoder",
                  environment: [
                    { name: "BUCKET_NAME", value: bucket.name },
                    { name: "KEY", value: key },
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
