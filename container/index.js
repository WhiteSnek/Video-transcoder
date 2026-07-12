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

const FFMPEG_THREADS = 2;
const S3_UPLOAD_CONCURRENCY = 6;

const s3Client = new S3Client({});

const BUCKET = process.env.INPUT_BUCKET;
const KEY = process.env.KEY;
const OUTPUT_BUCKET = process.env.OUTPUT_BUCKET;


async function downloadFile(bucket, key, outputPath) {
  const command = new GetObjectCommand({ Bucket: bucket, Key: key });
  const result = await s3Client.send(command);

  return new Promise((resolve, reject) => {
    const writeStream = fs.createWriteStream(outputPath);
    result.Body.on("error", reject); // readable-side errors don't auto-propagate through pipe
    result.Body.pipe(writeStream).on("error", reject).on("finish", resolve);
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

async function runWithConcurrency(items, limit, worker) {
  let idx = 0;
  async function next() {
    const current = idx++;
    if (current >= items.length) return;
    await worker(items[current], current);
    return next();
  }
  const runners = Array.from({ length: Math.min(limit, items.length) }, next);
  await Promise.all(runners);
}

async function listFilesRecursive(dir, base = dir) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursive(fullPath, base)));
    } else {
      const relKey = path.posix.relative(base, fullPath).split(path.sep).join("/");
      files.push({ fullPath, relKey });
    }
  }
  return files;
}

async function uploadDirectoryToS3(dirPath, s3Prefix) {
  const files = await listFilesRecursive(dirPath);
  await runWithConcurrency(files, S3_UPLOAD_CONCURRENCY, ({ fullPath, relKey }) =>
    uploadFileToS3(fullPath, path.posix.join(s3Prefix, relKey))
  );
}

async function deleteOriginalFile(bucket, key) {
  try {
    await s3Client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    console.log(`Deleted original file from S3: ${key}`);
  } catch (error) {
    console.error("Error deleting original file from S3:", error);
  }
}


function getVideoInfo(inputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(inputPath, (err, data) => {
      if (err) return reject(err);
      const videoStream = data.streams.find((s) => s.codec_type === "video");
      if (!videoStream) return reject(new Error("No video stream found in input"));
      resolve({ width: videoStream.width, height: videoStream.height });
    });
  });
}

function selectResolutions(sourceHeight) {
  const eligible = RESOLUTIONS.filter((r) => r.height <= sourceHeight);
  return eligible.length > 0 ? eligible : [RESOLUTIONS[0]];
}

async function transcodeAllResolutions(inputPath, outputBaseDir, resolutions) {
  await Promise.all(
    resolutions.map((r) => fsp.mkdir(path.join(outputBaseDir, r.name), { recursive: true }))
  );

  const filterParts = [`[0:v]split=${resolutions.length}${resolutions.map((_, i) => `[v${i}]`).join("")}`];
  resolutions.forEach((r, i) => {
    filterParts.push(`[v${i}]scale=w=${r.width}:h=${r.height}:force_original_aspect_ratio=decrease[v${i}out]`);
  });

  const outputOptions = [];
  resolutions.forEach((r, i) => {
    outputOptions.push(
      "-map", `[v${i}out]`,
      `-c:v:${i}`, "libx264",
      `-b:v:${i}`, `${r.bandwidth}`,
      `-maxrate:v:${i}`, `${Math.round(r.bandwidth * 1.07)}`,
      `-bufsize:v:${i}`, `${Math.round(r.bandwidth * 1.5)}`,
      "-map", "0:a:0?",
      `-c:a:${i}`, "aac",
      `-b:a:${i}`, "128k"
    );
  });

  const varStreamMap = resolutions.map((r, i) => `v:${i},a:${i},name:${r.name}`).join(" ");

  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .complexFilter(filterParts)
      .outputOptions([
        ...outputOptions,
        "-preset", "veryfast",
        "-threads", String(FFMPEG_THREADS),
        "-g", "48",
        "-sc_threshold", "0",
        "-hls_time", "2",
        "-hls_playlist_type", "vod",
        "-hls_flags", "independent_segments",
        "-master_pl_name", "master.m3u8",
        "-var_stream_map", varStreamMap,
        "-hls_segment_filename", path.join(outputBaseDir, "%v", "segment_%03d.ts"),
        "-f", "hls",
      ])
      .output(path.join(outputBaseDir, "%v", "index.m3u8"))
      .on("start", (cmd) => console.log("FFmpeg command:", cmd))
      .on("progress", (p) => {
        if (p.percent) console.log(`Encoding progress: ${p.percent.toFixed(1)}%`);
      })
      .on("end", resolve)
      .on("error", reject)
      .run();
  });
}


async function cleanupLocal(paths) {
  await Promise.all(
    paths.map((p) => fsp.rm(p, { recursive: true, force: true }).catch(() => {}))
  );
}


async function init() {
  const originalFilePath = path.resolve("original-video.mp4");
  const outputDir = path.resolve("output");

  try {
    console.log(`Downloading s3://${BUCKET}/${KEY} ...`);
    await downloadFile(BUCKET, KEY, originalFilePath);

    const { height: sourceHeight } = await getVideoInfo(originalFilePath);
    const resolutions = selectResolutions(sourceHeight);
    console.log(
      `Source height ${sourceHeight}px -> encoding renditions: ${resolutions.map((r) => r.name).join(", ")}`
    );
    await transcodeAllResolutions(originalFilePath, outputDir, resolutions);

    await uploadDirectoryToS3(outputDir, KEY);
    await deleteOriginalFile(BUCKET, KEY);

    console.log("Transcoding and upload complete!");
  } catch (error) {
    console.error("Error in init:", error);
    throw error;
  } finally {
    await cleanupLocal([originalFilePath, outputDir]);
  }
}

init().catch((error) => {
  console.error("Unexpected error:", error);
  process.exitCode = 1; 
});