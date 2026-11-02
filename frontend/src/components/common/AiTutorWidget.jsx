import React, { useState, useRef, useEffect } from 'react';
import { X, Send, Minimize2, Maximize2, Bot, User, BookOpen, Loader2, Sparkles } from 'lucide-react';
import apiClient, { API_URL } from '../../api/client';
import MarkdownView from './MarkdownView';

function ChatMessage({ msg }) {
  const isUser = msg.role === 'user';
  return (
    <div className={`flex gap-2.5 ${isUser ? 'flex-row-reverse' : ''}`}>
      <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${isUser ? 'bg-blue-600' : 'bg-gradient-to-tr from-indigo-500 to-purple-600'}`}>
        {isUser ? <User className="w-4 h-4 text-white" /> : <Bot className="w-4 h-4 text-white" />}
      </div>
      <div className={`max-w-[82%] ${isUser ? 'items-end' : 'items-start'} flex flex-col gap-1`}>
        <div className={`px-4 py-3 rounded-2xl text-sm leading-relaxed ${isUser
          ? 'bg-blue-600 text-white rounded-tr-sm'
          : 'bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-800 dark:text-slate-200 rounded-tl-sm'
        }`}>
          {msg.isStreaming ? (
            <span>
              {msg.content}
              <span className="inline-block w-1.5 h-4 bg-blue-400 ml-0.5 animate-pulse rounded" />
            </span>
          ) : (
            msg.role === 'assistant' ? (
              <MarkdownView content={msg.content} compact />
            ) : (
              <p>{msg.content}</p>
            )
          )}
        </div>
        {msg.sources?.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-1">
            {msg.sources.map((src, i) => (
              <span key={i} className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-indigo-100 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800">
                <BookOpen className="w-3 h-3" />
                {src}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function AiTutorWidget({ courseId, notes = [] }) {
  const [isOpen, setIsOpen] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [messages, setMessages] = useState([
    { id: 'welcome', role: 'assistant', content: "Hi! I'm your AI tutor for this course. Ask me anything about the course material, and I'll ground my answers in the uploaded notes. 🎓" }
  ]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [selectedNotes, setSelectedNotes] = useState([]);
  const [showNoteSelector, setShowNoteSelector] = useState(false);
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages]);

  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isOpen]);

  const sendMessage = async () => {
    const text = input.trim();
    if (!text || streaming) return;
    setInput('');

    const userMsg = { id: Date.now(), role: 'user', content: text };
    setMessages((prev) => [...prev, userMsg]);

    // AI placeholder
    const aiMsgId = Date.now() + 1;
    setMessages((prev) => [...prev, { id: aiMsgId, role: 'assistant', content: '', isStreaming: true }]);
    setStreaming(true);

    try {
      const makeRequest = (token) => fetch(`${API_URL}/chat`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
          ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          message: text,
          course_id: courseId,
          note_ids: selectedNotes.length > 0 ? selectedNotes : undefined,
        }),
      });
      let token = localStorage.getItem('vidyaranya_token');
      let res = await makeRequest(token);
      if (res.status === 401) {
        const refreshed = await apiClient.post('/auth/refresh', {});
        token = refreshed.data.access_token;
        localStorage.setItem('vidyaranya_token', token);
        res = await makeRequest(token);
      }

      if (!res.ok) {
        let detail = `AI Tutor request failed (${res.status})`;
        try {
          const payload = await res.json();
          detail = payload.detail || detail;
        } catch {
          // Keep the HTTP status message when the response is not JSON.
        }
        throw new Error(detail);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let fullContent = '';
      let sources = [];
      let buffer = '';

      const processEvent = (block) => {
        let eventType = 'message';
        const dataLines = [];
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) eventType = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
        }
        if (!dataLines.length) return;

        const data = JSON.parse(dataLines.join('\n'));
        const type = data.type || eventType;
        if (type === 'token') {
          fullContent += data.content || '';
          setMessages((prev) =>
            prev.map((m) => m.id === aiMsgId ? { ...m, content: fullContent } : m)
          );
        } else if (type === 'metadata' || type === 'sources') {
          sources = data.sources || [];
        } else if (type === 'error') {
          throw new Error(data.detail || data.message || 'AI tutor stream failed. Please retry.');
        }
      };

      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        buffer = buffer.replace(/\r\n/g, '\n');
        let eventBoundary = buffer.indexOf('\n\n');
        while (eventBoundary !== -1) {
          const eventBlock = buffer.slice(0, eventBoundary);
          buffer = buffer.slice(eventBoundary + 2);
          processEvent(eventBlock);
          eventBoundary = buffer.indexOf('\n\n');
        }
        if (done) {
          if (buffer.trim()) processEvent(buffer);
          break;
        }
      }

      // Ensure stream is marked complete
      setMessages((prev) =>
        prev.map((m) => m.id === aiMsgId ? { ...m, content: fullContent || 'I could not generate a response. Please try again.', isStreaming: false, sources } : m)
      );
    } catch (err) {
      setMessages((prev) =>
        prev.map((m) => m.id === aiMsgId ? { ...m, content: `Error: ${err.message || 'Failed to get response. Please check your connection.'}`, isStreaming: false } : m)
      );
    } finally {
      setStreaming(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const widgetWidth = isExpanded ? 'w-[600px]' : 'w-96';
  const widgetHeight = isExpanded ? 'h-[640px]' : 'h-[520px]';

  return (
    <>
      {/* Floating Toggle Button */}
      {!isOpen && (
        <button
          id="btn-open-ai-tutor"
          onClick={() => setIsOpen(true)}
          className="fixed bottom-6 right-6 z-50 w-14 h-14 rounded-full bg-gradient-to-tr from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white shadow-2xl shadow-indigo-500/40 flex items-center justify-center transition-all hover:scale-110 active:scale-95"
          aria-label="Open AI Tutor"
        >
          <Sparkles className="w-6 h-6" />
        </button>
      )}

      {/* Chat Panel */}
      {isOpen && (
        <div className={`fixed bottom-6 right-6 z-50 ${widgetWidth} ${widgetHeight} flex flex-col rounded-2xl shadow-2xl border border-slate-200/80 dark:border-slate-700/80 glass-panel bg-white/95 dark:bg-slate-900/95 transition-all`}>
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200/80 dark:border-slate-800/80 shrink-0">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-xl bg-gradient-to-tr from-indigo-500 to-purple-600 flex items-center justify-center">
                <Bot className="w-4 h-4 text-white" />
              </div>
              <div>
                <p className="text-sm font-bold text-slate-900 dark:text-white">AI Tutor</p>
                <p className="text-xs text-slate-400">{streaming ? 'Thinking…' : 'Ready to help'}</p>
              </div>
            </div>
            <div className="flex items-center gap-1">
              {notes.length > 0 && (
                <button
                  onClick={() => setShowNoteSelector(!showNoteSelector)}
                  className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500 hover:text-indigo-600 transition-colors"
                  title="Select course materials"
                >
                  <BookOpen className="w-4 h-4" />
                </button>
              )}
              <button onClick={() => setIsExpanded(!isExpanded)} className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500 transition-colors">
                {isExpanded ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
              </button>
              <button
                id="btn-close-ai-tutor"
                onClick={() => setIsOpen(false)}
                className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500 hover:text-red-500 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Note Selector */}
          {showNoteSelector && notes.length > 0 && (
            <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 bg-indigo-50/50 dark:bg-indigo-950/20 shrink-0">
              <p className="text-xs font-semibold text-slate-600 dark:text-slate-400 mb-2">Focus on these materials ({selectedNotes.length} selected):</p>
              <div className="space-y-1 max-h-24 overflow-y-auto">
                {notes.map((n) => (
                  <label key={n.id} className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={selectedNotes.includes(n.id)}
                      onChange={(e) => setSelectedNotes(e.target.checked ? [...selectedNotes, n.id] : selectedNotes.filter((id) => id !== n.id))}
                      className="w-3.5 h-3.5 rounded border-slate-300 text-indigo-600"
                    />
                    <span className="flex-1 text-xs text-slate-700 dark:text-slate-300 truncate">{n.title || n.file_name || n.filename}</span>
                    <span className={`text-[10px] ${n.chroma_indexed ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}`}>
                      {n.chroma_indexed ? 'Ready' : 'Available · search indexing pending'}
                    </span>
                  </label>
                ))}
              </div>
            </div>
          )}

          {/* Messages */}
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {messages.map((msg) => (
              <ChatMessage key={msg.id} msg={msg} />
            ))}
            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div className="px-4 py-3 border-t border-slate-200/80 dark:border-slate-800/80 shrink-0">
            <div className="flex items-end gap-2 bg-slate-50 dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 px-3 py-2.5">
              <textarea
                ref={inputRef}
                id="ai-tutor-input"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                disabled={streaming}
                placeholder="Ask me anything about the course…"
                rows={1}
                className="flex-1 bg-transparent resize-none text-sm text-slate-900 dark:text-white placeholder:text-slate-400 focus:outline-none max-h-32 overflow-y-auto"
                style={{ minHeight: '24px' }}
              />
              <button
                id="btn-send-ai-message"
                onClick={sendMessage}
                disabled={streaming || !input.trim()}
                className="w-8 h-8 rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-300 dark:disabled:bg-slate-700 text-white flex items-center justify-center transition-colors shrink-0"
              >
                {streaming ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
              </button>
            </div>
            <p className="text-[10px] text-slate-400 mt-1.5 text-center">Enter to send · Shift+Enter for new line</p>
          </div>
        </div>
      )}
    </>
  );
}
