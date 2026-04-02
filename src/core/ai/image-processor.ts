import sharp from 'sharp';
import * as fs from 'fs/promises';

export interface ImageProcessOptions {
  maxWidth: number;
  maxHeight: number;
  quality: number;
}

export class ImageProcessor {
  private readonly options: ImageProcessOptions;

  constructor(options: ImageProcessOptions = { maxWidth: 1024, maxHeight: 1024, quality: 85 }) {
    this.options = options;
  }

  async process(imagePath: string): Promise<Buffer> {
    const buffer = await fs.readFile(imagePath);

    const image = sharp(buffer);
    const metadata = await image.metadata();

    if (!metadata.width || !metadata.height) {
      return buffer;
    }

    const needsResize = metadata.width > this.options.maxWidth ||
                        metadata.height > this.options.maxHeight;

    if (!needsResize) {
      return buffer;
    }

    return image
      .resize(this.options.maxWidth, this.options.maxHeight, {
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: this.options.quality })
      .toBuffer();
  }
}
