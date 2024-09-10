const { S3Client, GetObjectCommand, PutObjectCommand } = require("@aws-sdk/client-s3");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const ffmpeg = require("fluent-ffmpeg");
import * as dotenv from 'dotenv';
dotenv.config();

const RESOLUTIONS = [
  { name: "360p", width: 480, height: 360 },
  { name: "480p", width: 854, height: 480 },
  { name: "720p", width: 1280, height: 720 },
];

const s3Client = new S3Client({
  region: "us-east-1",
  credentials: {
    accessKeyId: process.env.ACCESS_KEY_ID,
    secretAccessKey: process.env.SECRET_ACCESS_KEY,
  },
});
const BUCKET = process.env.BUCKET_NAME;
const KEY = process.env.KEY;

async function downloadFile(bucket, key, outputPath) {
  const command = new GetObjectCommand({ Bucket: bucket, Key: key });
  const result = await s3Client.send(command);

  return new Promise((resolve, reject) => {
    const writeStream = fs.createWriteStream(outputPath);
    result.Body.pipe(writeStream)
      .on('error', reject)
      .on('close', resolve);
  });
}

async function init() {
  const originalFilePath = path.resolve("original-video.mp4");

  try {
    // Download the video from S3
    await downloadFile(BUCKET, KEY, originalFilePath);
    console.log(`Downloaded video to ${originalFilePath}`);

    // Start the transcoder
    const promises = RESOLUTIONS.map(async (resolution) => {
      const outputDir = path.join(__dirname, `${resolution.name}`);
      await fsp.mkdir(outputDir, { recursive: true }); // Ensure the directory exists
      const outputFile = `${outputDir}/index.m3u8`;

      return new Promise((resolve, reject) => {
        ffmpeg(originalFilePath)
          .outputOptions([
            '-preset veryfast',
            '-g 48',
            '-sc_threshold 0',
            '-hls_time 2',
            '-hls_playlist_type vod',
            '-hls_segment_filename', path.join(outputDir, 'segment%03d.ts'),
            '-loglevel', 'verbose',  // Add verbose logging
          ])
          .output(outputFile)
          .videoCodec("libx264")
          .audioCodec("aac")
          .size(`${resolution.width}x${resolution.height}`)
          .on("end", async () => {
            try {
              const files = await fsp.readdir(outputDir);
              for (const file of files) {
                const fileContent = await fsp.readFile(path.join(outputDir, file));
                const putCommand = new PutObjectCommand({
                  Bucket: "gametube-video-transcoded",
                  Key: `${KEY}/${resolution.name}/${file}`,
                  Body: fileContent,
                });
                await s3Client.send(putCommand);
                console.log("Uploaded", file);
              }
              resolve();
            } catch (error) {
              console.error("Error uploading file:", error);
              reject(error);
            }
          })
          .on("error", (err) => {
            console.error("Error during transcoding:", err);
            reject(err);
          })
          .format("hls")
          .run();
      });
    });

    await Promise.all(promises);
  } catch (error) {
    console.error("Error in init:", error);
  }
}

init().catch((error) => console.error("Unexpected error in init:", error));
