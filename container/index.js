const {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} = require("@aws-sdk/client-s3");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const ffmpeg = require("fluent-ffmpeg");
const dotenv = require("dotenv");
dotenv.config();

const RESOLUTIONS = [
  { name: "480p", width: 854, height: 480, bandwidth: 800000 },
  { name: "720p", width: 1280, height: 720, bandwidth: 1400000 },
  { name: "1080p", width: 1920, height: 1080, bandwidth: 2800000 },
];

const s3Client = new S3Client({});

const BUCKET = process.env.INPUT_BUCKET;
const KEY = process.env.KEY;
const OUTPUT_BUCKET = process.env.OUTPUT_BUCKET;

async function downloadFile(bucket, key, outputPath) {
  const command = new GetObjectCommand({ Bucket: bucket, Key: key });
  const result = await s3Client.send(command);

  return new Promise((resolve, reject) => {
    const writeStream = fs.createWriteStream(outputPath);
    result.Body.pipe(writeStream)
      .on("error", reject)
      .on("finish", resolve);
  });
}

async function uploadFileToS3(filePath, s3Key) {
  const fileStream = fs.createReadStream(filePath);
  const putCommand = new PutObjectCommand({
    Bucket: OUTPUT_BUCKET,
    Key: s3Key,
    Body: fileStream,
  });

  await s3Client.send(putCommand);
  console.log("Uploaded:", s3Key);
}

async function transcodeResolutions(inputPath, outputBaseDir) {
  const transcodePromises = RESOLUTIONS.map((res) => {
    const outputDir = path.join(outputBaseDir, res.name);
    return new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .outputOptions([
          "-preset veryfast",
          "-g 48",
          "-sc_threshold 0",
          "-hls_time 2",
          "-hls_playlist_type vod",
          `-hls_segment_filename ${outputDir}/segment_%03d.ts`,
        ])
        .output(path.join(outputDir, "index.m3u8"))
        .videoCodec("libx264")
        .audioCodec("aac")
        .size(`${res.width}x${res.height}`)
        .format("hls")
        .on("start", async () => {
          await fsp.mkdir(outputDir, { recursive: true });
        })
        .on("progress", (progress) => console.log(`${res.name} progress:`, progress))
        .on("end", () => resolve())
        .on("error", (err) => reject(err))
        .run();
    });
  });

  await Promise.all(transcodePromises);
}

async function createMasterPlaylist(outputDir) {
  const masterPath = path.join(outputDir, "master.m3u8");
  const lines = ["#EXTM3U"];

  for (const res of RESOLUTIONS) {
    lines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${res.bandwidth},RESOLUTION=${res.width}x${res.height}`,
      `${res.name}/index.m3u8`
    );
  }

  await fsp.writeFile(masterPath, lines.join("\n"));
  return masterPath;
}

async function uploadDirectoryToS3(dirPath, s3Prefix) {
  const entries = await fsp.readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    const s3Key = path.posix.join(s3Prefix, entry.name);

    if (entry.isDirectory()) {
      await uploadDirectoryToS3(fullPath, `${s3Prefix}/${entry.name}`);
    } else {
      await uploadFileToS3(fullPath, s3Key);
    }
  }
}

async function deleteOriginalFile(bucket, key) {
  try {
    const deleteCommand = new DeleteObjectCommand({ Bucket: bucket, Key: key });
    await s3Client.send(deleteCommand);
    console.log(`Deleted original file from S3: ${key}`);
  } catch (error) {
    console.error("Error deleting original file from S3:", error);
  }
}

async function init() {
  const originalFilePath = path.resolve("original-video.mp4");
  const outputDir = path.resolve("output");

  try {
    // Step 1: Download the original video from S3
    await downloadFile(BUCKET, KEY, originalFilePath);
    console.log(`Downloaded video: ${originalFilePath}`);

    // Step 2: Transcode video into different resolutions and generate HLS
    await transcodeResolutions(originalFilePath, outputDir);

    // Step 3: Create the master playlist
    const masterPlaylistPath = await createMasterPlaylist(outputDir);

    // Step 4: Upload the master playlist to S3
    await uploadFileToS3(masterPlaylistPath, `${KEY}/master.m3u8`);

    // Step 5: Upload the transcoded video files (including segments) to S3
    await uploadDirectoryToS3(outputDir, KEY);

    // Step 6: Delete the original file from S3
    await deleteOriginalFile(BUCKET, KEY);

    console.log("Transcoding and upload complete!");
  } catch (error) {
    console.error("Error in init:", error);
  }
}

init().catch((error) => console.error("Unexpected error:", error));
