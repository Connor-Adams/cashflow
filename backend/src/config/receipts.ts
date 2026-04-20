import path from 'path';

const backendRoot = path.join(__dirname, '..', '..');

export function getReceiptsUploadDir(): string {
  return (
    process.env.RECEIPTS_UPLOAD_DIR?.trim() ||
    path.join(backendRoot, 'uploads', 'receipts')
  );
}
