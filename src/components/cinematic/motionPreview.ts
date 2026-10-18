/** An explicit URL keeps scene studies separate from normal navigation. */
export function isArchiveMotionPreview(): boolean {
  return typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).get('preview') === 'archive-motion';
}
