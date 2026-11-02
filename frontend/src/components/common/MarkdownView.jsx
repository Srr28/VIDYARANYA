import React from 'react';

export default function MarkdownView({ content, className = '' }) {
  if (!content) return null;

  const normalizedContent = String(content)
    .replace(/(?:[\u00C2-\u00DF][\u0080-\u00BF]|[\u00E0-\u00EF][\u0080-\u00BF]{2}|[\u00F0-\u00F4][\u0080-\u00BF]{3})+/g, (fragment) => {
      try {
        const bytes = Uint8Array.from([...fragment].map((character) => character.charCodeAt(0)));
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        return fragment;
      }
    })
    .replace(/\\\|/g, '|')
    .replace(/\\?<br\s*\/?\s*>/gi, '<br/>')
    .replace(/&lt;br\s*\/?&gt;/gi, '<br/>')
    .replace(/\\(?=-{3,}\s*$)/gm, '');

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
          <ul key={`ul-${elements.length}`} className="list-disc list-inside space-y-1 my-2 text-muted-foreground ">
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
      const parts = str.split(/(\*\*.*?\*\*|\*.*?\*|`.*?`|\[.*?\]\(.*?\)|<br\s*\/?\s*>)/gi);
      return parts.map((part, index) => {
        if (/^<br\s*\/?\s*>$/i.test(part)) return <br key={index} />;
        if (part.startsWith('**') && part.endsWith('**')) {
          return <strong key={index} className="font-semibold text-foreground ">{part.slice(2, -2)}</strong>;
        }
        if (part.startsWith('*') && part.endsWith('*')) {
          return <em key={index} className="italic">{part.slice(1, -1)}</em>;
        }
        if (part.startsWith('`') && part.endsWith('`')) {
          return (
            <code key={index} className="px-1.5 py-0.5 rounded bg-muted  text-primary  font-mono text-xs">
              {part.slice(1, -1)}
            </code>
          );
        }
        // Citation chips [Source: ...]
        if (part.startsWith('[') && part.includes(']')) {
          return (
            <span key={index} className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-secondary  text-primary  border border-primary  mx-1">
              {part}
            </span>
          );
        }
        return part;
      });
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (/^\s*\|.*\|\s*$/.test(line)) {
        flushList();
        const tableLines = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
          tableLines.push(lines[i].trim());
          i += 1;
        }
        i -= 1;
        const rows = tableLines.map((row) => row.replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim()));
        const isSeparator = (row) => row.every((cell) => /^:?-{3,}:?$/.test(cell));
        const header = rows[0] || [];
        const bodyRows = rows.slice(1).filter((row) => !isSeparator(row));
        elements.push(
          <div key={`table-${i}`} className="my-3 overflow-x-auto">
            <table className="min-w-full border-collapse text-left text-xs sm:text-sm">
              <thead>
                <tr>{header.map((cell, cellIndex) => <th key={cellIndex} className="border border-border  bg-muted  px-2.5 py-2 font-semibold text-foreground ">{parseInline(cell)}</th>)}</tr>
              </thead>
              <tbody>
                {bodyRows.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    {header.map((_, cellIndex) => <td key={cellIndex} className="border border-border  px-2.5 py-2 align-top text-muted-foreground ">{parseInline(row[cellIndex] || '')}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
        continue;
      }

      // Code blocks
      if (line.trim().startsWith('```')) {
        if (inCodeBlock) {
          elements.push(
            <pre key={`code-${i}`} className="p-4 my-3 rounded-xl bg-card text-muted-foreground font-mono text-xs overflow-x-auto border border-border">
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

      if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
        flushList();
        elements.push(<hr key={`hr-${i}`} className="my-3 border-border " />);
        continue;
      }

      // Headers
      if (line.startsWith('# ')) {
        flushList();
        elements.push(
          <h1 key={`h1-${i}`} className="text-xl font-bold text-foreground  mt-4 mb-2 pb-1 border-b border-border ">
            {parseInline(line.replace('# ', ''))}
          </h1>
        );
      } else if (line.startsWith('## ')) {
        flushList();
        elements.push(
          <h2 key={`h2-${i}`} className="text-lg font-bold text-foreground  mt-3 mb-2 flex items-center gap-2">
            {parseInline(line.replace('## ', ''))}
          </h2>
        );
      } else if (line.startsWith('### ')) {
        flushList();
        elements.push(
          <h3 key={`h3-${i}`} className="text-base font-semibold text-foreground  mt-2 mb-1">
            {parseInline(line.replace('### ', ''))}
          </h3>
        );
      } else if (/^(?:[-*•]|\d+[.)])\s+/.test(line.trim())) {
        listBuffer.push(line.trim().replace(/^(?:[-*•]|\d+[.)])\s+/, ''));
      } else if (line.trim().startsWith('>')) {
        flushList();
        elements.push(
          <blockquote key={`quote-${i}`} className="border-l-4 border-primary pl-4 py-1.5 my-2 italic text-muted-foreground  bg-secondary  rounded-r-lg">
            {parseInline(line.replace(/^>\s*/, ''))}
          </blockquote>
        );
      } else if (line.trim() === '') {
        flushList();
      } else {
        flushList();
        elements.push(
          <p key={`p-${i}`} className="my-2 leading-relaxed text-muted-foreground ">
            {parseInline(line)}
          </p>
        );
      }
    }

    if (inCodeBlock && codeBuffer.length) {
      elements.push(
        <pre key="code-unclosed" className="p-4 my-3 rounded-xl bg-card text-muted-foreground font-mono text-xs overflow-x-auto border border-border">
          <code>{codeBuffer.join('\n')}</code>
        </pre>
      );
    }
    flushList();
    return elements;
  };

  return <div className={`text-sm ${className}`}>{renderFormattedText(normalizedContent)}</div>;
}
