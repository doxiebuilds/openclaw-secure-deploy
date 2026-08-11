import { useEffect, useRef, useState } from 'react';
import SyntaxHighlighter from 'react-syntax-highlighter';
import { vs, vs2015 } from 'react-syntax-highlighter/dist/esm/styles/hljs';
import { Button } from './Button';

const PREVIEW_LINES = 3;
const COLLAPSED_HEIGHT = PREVIEW_LINES * 20 + 13;

function useSyntaxTheme() {
  const [dark, setDark] = useState(() => document.documentElement.getAttribute('data-theme') === 'dark');
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setDark(document.documentElement.getAttribute('data-theme') === 'dark');
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);
  return dark ? vs2015 : vs;
}

export function CodeBlock({ code, language = 'text' }: { code: string; language?: string }) {
  const style = useSyntaxTheme();
  const lineCount = code.split('\n').length;
  const collapsible = lineCount > PREVIEW_LINES;
  const [expanded, setExpanded] = useState(!collapsible);
  const ref = useRef<HTMLDivElement>(null);

  return (
    <div className="rd-10px overflow-hidden border border-edge bg-panel my-8px">
      <div
        ref={ref}
        style={!expanded ? { maxHeight: COLLAPSED_HEIGHT, overflow: 'hidden' } : undefined}
      >
        <SyntaxHighlighter
          language={language}
          style={style}
          customStyle={{
            margin: 0,
            padding: '10px 12px',
            fontSize: 'var(--ocp-code-size, 13px)',
            lineHeight: 1.5,
            background: 'transparent',
          }}
        >
          {code}
        </SyntaxHighlighter>
      </div>
      {collapsible ? (
        <div className="border-t border-edge-soft px-8px py-4px">
          <Button variant="text" size="sm" onClick={() => setExpanded((v) => !v)}>
            {expanded ? 'Show less' : `Show ${lineCount - PREVIEW_LINES} more lines`}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
