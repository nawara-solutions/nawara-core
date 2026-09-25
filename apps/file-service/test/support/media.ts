import { randomBytes } from 'node:crypto';

/**
 * Minimal files of each V1 type (their leading structures are real; detection is a signature check), and adversarial samples.
 * `pad` appends random bytes so a sample can be any size.
 */
const pad = (head: Buffer, size = 0) => (size > head.length ? Buffer.concat([head, randomBytes(size - head.length)]) : head);

/** An ISO-BMFF `ftyp` box: size, 'ftyp', major brand, minor version 0, compatible brands. */
export function ftyp(major: string, compatible: string[]): Buffer {
  const size = 16 + 4 * compatible.length;
  const box = Buffer.alloc(size);
  box.writeUInt32BE(size, 0);
  box.write('ftyp', 4, 'latin1');
  box.write(major, 8, 'latin1');
  compatible.forEach((b, i) => box.write(b, 16 + 4 * i, 'latin1'));
  return box;
}

const riff = (form: string, chunk: string) => {
  const b = Buffer.alloc(16);
  b.write('RIFF', 0, 'latin1');
  b.writeUInt32LE(1024, 4);
  b.write(form, 8, 'latin1');
  b.write(chunk, 12, 'latin1');
  return b;
};

export const SAMPLES = {
  pdf: (size = 0) => pad(Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n', 'latin1'), size),
  jpeg: (size = 0) => pad(Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64'), size),
  png: (size = 0) => pad(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'), size),
  webp: (size = 0) => pad(riff('WEBP', 'VP8 '), Math.max(size, 64)),
  /** An iPhone HEIC header: major `heic`, compatible `mif1`, `heic` (then a meta box would follow). */
  heic: (size = 0) => pad(Buffer.concat([ftyp('heic', ['mif1', 'heic']), Buffer.from('\x00\x00\x00\x08meta', 'latin1')]), Math.max(size, 64)),
  /** A generic HEIF still image (major `mif1`, no HEVC brand): image/heif. */
  heif: (size = 0) => pad(Buffer.concat([ftyp('mif1', ['mif1', 'miaf']), Buffer.from('\x00\x00\x00\x08meta', 'latin1')]), Math.max(size, 64)),
  /** Samsung-style: major `mif1` with HEVC `heic` compatible: image/heic. */
  heicMif1: (size = 0) => pad(Buffer.concat([ftyp('mif1', ['mif1', 'heic', 'miaf']), Buffer.from('\x00\x00\x00\x08meta', 'latin1')]), Math.max(size, 64)),
};

export const ADVERSARIAL = {
  windowsExe: () => pad(Buffer.from('MZ\x90\x00\x03\x00\x00\x00\x04\x00\x00\x00\xff\xff\x00\x00', 'latin1'), 512),
  elf: () => pad(Buffer.from('\x7fELF\x02\x01\x01', 'latin1'), 512),
  zip: () => pad(Buffer.from('PK\x03\x04\x14\x00\x00\x00', 'latin1'), 512),
  docx: () => pad(Buffer.from('PK\x03\x04\x14\x00\x06\x00\x08\x00\x00\x00!\x00[Content_Types].xml', 'latin1'), 512),
  oleDoc: () => pad(Buffer.from('\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1', 'latin1'), 512),
  gzip: () => pad(Buffer.from('\x1f\x8b\x08\x00', 'latin1'), 512),
  rar: () => pad(Buffer.from('Rar!\x1a\x07\x01\x00', 'latin1'), 512),
  html: () => Buffer.from('<!DOCTYPE html><html><body><script>alert(1)</script></body></html>'),
  htmlWithBom: () => Buffer.from('﻿<html><script>alert(1)</script></html>'),
  svg: () => Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'),
  svgBare: () => Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
  shellScript: () => Buffer.from('#!/bin/sh\nrm -rf /\n'),
  gif: () => pad(Buffer.from('GIF89a', 'latin1'), 64), // an image, but not in the V1 allow-list
  avif: () => pad(ftyp('avif', ['avif', 'mif1', 'miaf']), 64),
  avifUnderMif1: () => pad(ftyp('mif1', ['avif', 'mif1', 'miaf']), 64),
  heicSequence: () => pad(ftyp('hevc', ['msf1', 'hevc']), 64),
  mp4: () => pad(ftyp('isom', ['isom', 'iso2', 'mp41']), 64),
  quicktime: () => pad(ftyp('qt  ', ['qt  ']), 64),
  pdfAfterJunk: () => Buffer.concat([Buffer.from('<html>'), SAMPLES.pdf()]), // "%PDF-" not at offset 0
  truncatedPng: () => Buffer.from('\x89PNG\r\n', 'latin1'), // 6 of the 8 signature bytes
  truncatedHeic: () => ftyp('heic', ['mif1', 'heic']).subarray(0, 14),
  lyingFtypSize: () => { const b = pad(ftyp('heic', ['mif1']), 64); b.writeUInt32BE(1_000_000, 0); return b; },
  randomBinary: () => randomBytes(4096),
  empty: () => Buffer.alloc(0),
  riffWave: () => pad(riff('WAVE', 'fmt '), 64),
};
