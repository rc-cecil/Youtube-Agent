import 'dotenv/config';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export async function createRemotionFixture(
  output = resolve('packages/remotion/public/sample-gameplay.mp4'),
) {
  await mkdir(dirname(output), { recursive: true });
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(
      process.env.FFMPEG_PATH || 'ffmpeg',
      [
        '-y',
        '-nostdin',
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=1280x720:rate=30',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=48000',
        '-t',
        '2',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-shortest',
        '-movflags',
        '+faststart',
        output,
      ],
      { shell: false, windowsHide: true, stdio: 'inherit' },
    );
    child.once('error', () =>
      reject(new Error('FFmpeg is required to create the Remotion fixture.')),
    );
    child.once('close', (code) =>
      code === 0
        ? resolvePromise()
        : reject(new Error(`Fixture generation failed with code ${code}.`)),
    );
  });
  return output;
}

const invokedPath = process.argv[1]?.replace(/\\/g, '/');
if (
  invokedPath &&
  import.meta.url.endsWith(invokedPath.startsWith('/') ? invokedPath : `/${invokedPath}`)
)
  await createRemotionFixture();
