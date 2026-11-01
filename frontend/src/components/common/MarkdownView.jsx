import React from 'react';

export default function MarkdownView({ content, className = '' }) {
  if (!content) return null;

  // Simple, resilient parser for markdown sections, code, bold, quotes, and citations
  const renderFormattedText = (text) => {
    // Split into lines
    const lines = text.split('\n');
    const elements = [];
    let inCodeBlock = false;
    let codeBuffer = [];
    let listBuffer = [];

    const flushList = () => {
      if (listBuffer.length > 0) {
        elements.push(
          <ul key={`ul-${elements.length}`} className="list-disc list-inside space-y-1 my-2 text-slate-700 dark:text-slate-300">
            {listBuffer.map((item, idx) => (
              <li key={idx} className="leading-relaxed">{parseInline(item)}</li>
            ))}
          </ul>
        );
        listBuffer = [];
      }
    };

    const parseInline = (str) => {
      // Parse bold **text**
      const parts = str.split(/(\*\*.*?\*\*|\*.*?\*|`.*?`|\[.*?\]\(.*?\))/g);
      return parts.map((part, index) => {
        if (part.startsWith('**') && part.endsWith('**')) {
          return <strong key={index} className="font-semibold text-slate-900 dark:text-white">{part.slice(2, -2)}</strong>;
        }
        if (part.startsWith('*') && part.endsWith('*')) {
          return <em key={index} className="italic">{part.slice(1, -1)}</em>;
        }
        if (part.startsWith('`') && part.endsWith('`')) {
          return (
            <code key={index} className="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-blue-600 dark:text-blue-400 font-mono text-xs">
              {part.slice(1, -1)}
            </code>
          );
        }
        // Citation chips [Source: ...]
        if (part.startsWith('[') && part.includes(']')) {
          return (
            <span key={index} className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-50 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800 mx-1">
              {part}
            </span>
          );
        }
        return part;
      });
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Code blocks
      if (line.trim().startsWith('```')) {
        if (inCodeBlock) {
          elements.push(
            <pre key={`code-${i}`} className="p-4 my-3 rounded-xl bg-slate-900 text-slate-100 font-mono text-xs overflow-x-auto border border-slate-800">
              <code>{codeBuffer.join('\n')}</code>
            </pre>
          );
          codeBuffer = [];
          inCodeBlock = false;
        } else {
          flushList();
          inCodeBlock = true;
        }
        continue;
      }

      if (inCodeBlock) {
        codeBuffer.push(line);
        continue;
      }

      // Headers
      if (line.startsWith('# ')) {
        flushList();
        elements.push(
          <h1 key={`h1-${i}`} className="text-xl font-bold text-slate-900 dark:text-white mt-4 mb-2 pb-1 border-b border-slate-200 dark:border-slate-800">
            {parseInline(line.replace('# ', ''))}
          </h1>
        );
      } else if (line.startsWith('## ')) {
        flushList();
        elements.push(
          <h2 key={`h2-${i}`} className="text-lg font-bold text-slate-900 dark:text-white mt-3 mb-2 flex items-center gap-2">
            {parseInline(line.replace('## ', ''))}
          </h2>
        );
      } else if (line.startsWith('### ')) {
        flushList();
        elements.push(
          <h3 key={`h3-${i}`} className="text-base font-semibold text-slate-900 dark:text-white mt-2 mb-1">
            {parseInline(line.replace('### ', ''))}
          </h3>
        );
      } else if (line.trim().startsWith('- ') || line.trim().startsWith('* ')) {
        listBuffer.push(line.trim().replace(/^[-*]\s+/, ''));
      } else if (line.trim().startsWith('>')) {
        flushList();
        elements.push(
          <blockquote key={`quote-${i}`} className="border-l-4 border-blue-500 pl-4 py-1.5 my-2 italic text-slate-600 dark:text-slate-400 bg-blue-50/50 dark:bg-blue-950/20 rounded-r-lg">
            {parseInline(line.replace(/^>\s*/, ''))}
          </blockquote>
        );
      } else if (line.trim() === '') {
        flushList();
      } else {
        flushList();
        elements.push(
          <p key={`p-${i}`} className="my-2 leading-relaxed text-slate-700 dark:text-slate-300">
            {parseInline(line)}
          </p>
        );
      }
    }

    flushList();
    return elements;
  };

  return <div className={`text-sm ${className}`}>{renderFormattedText(content)}</div>;
}
