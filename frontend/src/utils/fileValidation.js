const ALLOWED_EXTENSIONS = new Set([
  'pdf', 'docx', 'pptx', 'xlsx', 'txt', 'md', 'csv',
  'png', 'jpg', 'jpeg', 'gif', 'tif', 'tiff', 'bmp', 'webp', 'py', 'js', 'jsx', 'ts', 'tsx', 'java',
  'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'go', 'rs', 'php', 'rb',
  'swift', 'kt', 'kts', 'sql', 'json', 'xml', 'yaml', 'yml', 'sh',
  'html', 'css',
]);
const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const CLASSROOM_FILE_ACCEPT = '.pdf,.docx,.pptx,.xlsx,.txt,.md,.csv,.png,.jpg,.jpeg,.gif,.tif,.tiff,.bmp,.webp,.py,.js,.jsx,.ts,.tsx,.java,.c,.h,.cc,.cpp,.hpp,.cs,.go,.rs,.php,.rb,.swift,.kt,.kts,.sql,.json,.xml,.yaml,.yml,.sh,.html,.css';

export function validateClassroomFile(file) {
  if (!file) return 'Choose a file first.';
  const extension = file.name.split('.').pop()?.toLowerCase();
  if (extension === 'doc' || extension === 'xls') return 'Convert legacy .doc/.xls files to DOCX/XLSX first.';
  if (!ALLOWED_EXTENSIONS.has(extension)) return 'Choose a supported document, image, or code file.';
  if (file.size > MAX_FILE_BYTES) return 'Files must be 10 MB or smaller.';
  return '';
}
