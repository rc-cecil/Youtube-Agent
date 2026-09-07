import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat, access } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  S3Client,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import type { Config } from '../../config/src/index.js';

export interface Storage {
  put(key: string, data: Readable): Promise<void>;
  read(key: string): Promise<Readable>;
  remove(key: string): Promise<void>;
  removeUploadParts(uploadId: string): Promise<void>;
  materialize(key: string): Promise<{ path: string; release(): Promise<void> }>;
  health(): Promise<void>;
}
export function validateKey(key: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9/_-]*\.[a-zA-Z0-9]+$/.test(key) || key.includes('..'))
    throw new Error('Invalid storage key');
}
function uploadPrefix(uploadId: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uploadId))
    throw new Error('Invalid upload ID');
  return `uploads/${uploadId}/`;
}
export class LocalStorage implements Storage {
  constructor(private root: string) {
    this.root = resolve(root);
  }
  path(key: string) {
    validateKey(key);
    const path = resolve(this.root, key);
    if (!path.startsWith(this.root + sep)) throw new Error('Storage path escapes root');
    return path;
  }
  async put(key: string, data: Readable) {
    const path = this.path(key),
      temp = `${path}.${randomUUID()}.tmp`;
    await mkdir(dirname(path), { recursive: true });
    try {
      await pipeline(data, createWriteStream(temp, { flags: 'wx' }));
      await rename(temp, path);
    } finally {
      await rm(temp, { force: true });
    }
  }
  async read(key: string) {
    const path = this.path(key);
    await access(path);
    return createReadStream(path);
  }
  async remove(key: string) {
    await rm(this.path(key), { force: true });
  }
  async removeUploadParts(uploadId: string) {
    const prefix = uploadPrefix(uploadId);
    const target = resolve(this.root, prefix);
    if (!target.startsWith(resolve(this.root, 'uploads') + sep))
      throw new Error('Cleanup target escapes upload storage');
    await rm(target, { recursive: true, force: true });
  }
  async materialize(key: string) {
    const path = this.path(key);
    await stat(path);
    return { path, release: async () => {} };
  }
  async health() {
    const key = `health/${randomUUID()}.bin`;
    await this.put(key, Readable.from('ok'));
    await this.remove(key);
  }
}
export class S3Storage implements Storage {
  private client: S3Client;
  private scratch: LocalStorage;
  constructor(private config: Config) {
    this.client = new S3Client({
      region: config.STORAGE_REGION,
      endpoint: config.STORAGE_ENDPOINT || undefined,
      forcePathStyle: Boolean(config.STORAGE_ENDPOINT),
    });
    this.scratch = new LocalStorage(resolve(config.STORAGE_ROOT, 'scratch'));
  }
  async put(key: string, data: Readable) {
    validateKey(key);
    await new Upload({
      client: this.client,
      params: { Bucket: this.config.STORAGE_BUCKET, Key: key, Body: data },
      queueSize: 2,
      partSize: 8 * 1024 ** 2,
      leavePartsOnError: false,
    }).done();
  }
  async read(key: string) {
    validateKey(key);
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.config.STORAGE_BUCKET, Key: key }),
    );
    if (!(result.Body instanceof Readable))
      throw new Error('Object storage returned no readable body');
    return result.Body;
  }
  async remove(key: string) {
    validateKey(key);
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.config.STORAGE_BUCKET, Key: key }),
    );
  }
  async removeUploadParts(uploadId: string) {
    const Prefix = uploadPrefix(uploadId);
    let ContinuationToken: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.config.STORAGE_BUCKET, Prefix, ContinuationToken }),
      );
      const Objects = (page.Contents ?? [])
        .filter((object) => object.Key?.startsWith(Prefix))
        .map((object) => ({ Key: object.Key! }));
      if (Objects.length) {
        const result = await this.client.send(
          new DeleteObjectsCommand({ Bucket: this.config.STORAGE_BUCKET, Delete: { Objects } }),
        );
        if (result.Errors?.length)
          throw new Error('Some expired upload parts could not be deleted');
      }
      ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (ContinuationToken);
  }
  async materialize(key: string) {
    const scratchKey = `jobs/${randomUUID()}.media`;
    try {
      await this.scratch.put(scratchKey, await this.read(key));
    } catch (error) {
      await this.scratch.remove(scratchKey);
      throw error;
    }
    return { path: this.scratch.path(scratchKey), release: () => this.scratch.remove(scratchKey) };
  }
  async health() {
    await this.client.send(new HeadBucketCommand({ Bucket: this.config.STORAGE_BUCKET }));
  }
}
export const createStorage = (config: Config): Storage =>
  config.STORAGE_PROVIDER === 's3' ? new S3Storage(config) : new LocalStorage(config.STORAGE_ROOT);
