import { CodeBlock } from './CodeBlock';
import { Button } from './Button';
import { Icon } from './Icon';
import { toast } from './toast';

export function JsonView({ value, title }: { value: unknown; title?: string }) {
  const text = JSON.stringify(value, null, 2);
  return (
    <div>
      {title ? (
        <div className="flex items-center justify-between mb-6px">
          <span className="text-13px text-ink-2 font-medium">{title}</span>
          <Button
            variant="text"
            size="sm"
            icon={<Icon.Copy size={13} />}
            onClick={() => {
              void navigator.clipboard.writeText(text);
              toast.success('Copied to clipboard');
            }}
          >
            Copy
          </Button>
        </div>
      ) : null}
      <CodeBlock code={text} language="json" />
    </div>
  );
}
