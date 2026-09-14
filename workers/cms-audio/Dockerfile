FROM --platform=linux/amd64 public.ecr.aws/lambda/nodejs:22 AS binaries
ARG FFMPEG_VERSION=6.0.1
ARG FFMPEG_SHA256=28268bf402f1083833ea269331587f60a242848880073be8016501d864bd07a5
RUN dnf install -y tar xz gzip && dnf clean all
RUN curl -fsSL "https://johnvansickle.com/ffmpeg/old-releases/ffmpeg-${FFMPEG_VERSION}-amd64-static.tar.xz" -o /tmp/ffmpeg.tar.xz \
 && echo "${FFMPEG_SHA256}  /tmp/ffmpeg.tar.xz" | sha256sum -c - \
 && mkdir /opt/ffmpeg && tar -xf /tmp/ffmpeg.tar.xz --strip-components=1 -C /opt/ffmpeg
FROM --platform=linux/amd64 public.ecr.aws/lambda/nodejs:22 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY workers/cms-audio/handler.ts workers/cms-audio/database-target.ts workers/cms-audio/
COPY src/modules/media/transcode-track-audio.ts src/modules/media/track-audio-contract.ts src/modules/media/
RUN npx esbuild workers/cms-audio/handler.ts --bundle --platform=node --target=node22 --format=cjs --outfile=dist/handler.cjs --external:pg-native
FROM --platform=linux/amd64 public.ecr.aws/lambda/nodejs:22
COPY --from=binaries /opt/ffmpeg/ffmpeg /usr/local/bin/ffmpeg
COPY --from=binaries /opt/ffmpeg/ffprobe /usr/local/bin/ffprobe
COPY --from=build /app/dist/handler.cjs ${LAMBDA_TASK_ROOT}/handler.js
RUN ffmpeg -version && ffprobe -version
CMD ["handler.handler"]
