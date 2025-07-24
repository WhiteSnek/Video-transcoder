# Stage 1: Base image for dependency installation
FROM node:20-slim as builder

# Set working directory
WORKDIR /app

# Copy package files first for better caching
COPY package*.json ./

# Install dependencies
RUN npm install --only=production

# Copy application files
COPY . .

# Stage 2: Final runtime image
FROM node:20-slim

# Install FFmpeg only in the runtime stage
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*  # Clean up to reduce image size

# Set working directory
WORKDIR /app

# Copy dependencies and application files from builder stage
COPY --from=builder /app /app

# Run the script
CMD ["node", "index.js"]
