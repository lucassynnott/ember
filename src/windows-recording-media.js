const path = require("node:path");
const { runCommand } = require("./transcription");

function recordingFiles(output) {
  const folder = path.dirname(output);
  return {
    video: output,
    camera: path.join(folder, "recording.camera.mp4"),
    system: path.join(folder, "recording.system.m4a"),
    thumb: path.join(folder, "recording.jpg"),
    wav: path.join(folder, "recording.wav"),
    cursor: path.join(folder, "recording.cursor.json"),
    rawVideo: path.join(folder, "capture.video.webm"),
    rawCamera: path.join(folder, "capture.camera.webm"),
    rawSystem: path.join(folder, "capture.system.webm"),
  };
}

// Native capture writes a microphone-only video and a separate system track.
// The WAV used for notes contains both, regardless of the editor's later mix.
function conversionCommands(files, { duration, microphone, camera, system }) {
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("Nothing was recorded.");
  const base = ["-nostdin", "-hide_banner", "-loglevel", "error", "-y"];
  const video = ["-i", files.rawVideo, "-map", "0:v:0", "-map", "0:a?", "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", files.video];
  const commands = [base.concat(video)];
  if (camera) commands.push(base.concat(["-i", files.rawCamera, "-an", "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", files.camera]));
  if (system) commands.push(base.concat(["-i", files.rawSystem, "-vn", "-c:a", "aac", files.system]));
  let audio;
  if (microphone && system) audio = ["-i", files.video, "-i", files.system, "-filter_complex", "[0:a][1:a]amix=inputs=2:duration=longest:normalize=0[a]", "-map", "[a]"];
  else if (microphone || system) audio = ["-i", microphone ? files.video : files.system, "-map", "0:a:0"];
  else audio = ["-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono", "-t", String(duration)];
  commands.push(base.concat(audio, ["-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", files.wav]));
  commands.push(base.concat(["-i", files.video, "-frames:v", "1", "-vf", "scale=640:-1", files.thumb]));
  return commands;
}

async function convertRecording(ffmpeg, files, metadata, run = runCommand, { signal } = {}) {
  for (const args of conversionCommands(files, metadata)) await run(ffmpeg, args, { signal });
}
module.exports = { recordingFiles, conversionCommands, convertRecording };
