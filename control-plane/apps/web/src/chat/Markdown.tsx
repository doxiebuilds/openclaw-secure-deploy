import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import { CodeBlock } from '../ui/CodeBlock';

export function Markdown({ text }: { text: string }) {
  return (
    <div className="ocp-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw]}
        components={{
          code(props) {
            const { children, className, node, ...rest } = props;
            const match = /language-(\w+)/.exec(className || '');
            const isBlock = Boolean(node?.position && node.position.start.line !== node.position.end.line);
            if (!isBlock && !match) {
              return (
                <code className={className} {...rest}>
                  {children}
                </code>
              );
            }
            return <CodeBlock code={String(children).replace(/\n$/, '')} language={match?.[1] ?? 'text'} />;
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
