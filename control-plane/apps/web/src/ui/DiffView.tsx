import { createTwoFilesPatch } from 'diff';
import { html as diff2html } from 'diff2html';
import { useMemo } from 'react';

export function DiffView({ before, after, beforeLabel = 'current', afterLabel = 'proposed' }: {
  before: string;
  after: string;
  beforeLabel?: string;
  afterLabel?: string;
}) {
  const markup = useMemo(() => {
    const patch = createTwoFilesPatch(beforeLabel, afterLabel, before, after, '', '', { context: 3 });
    return diff2html(patch, {
      drawFileList: false,
      matching: 'lines',
      outputFormat: 'line-by-line',
    });
  }, [before, after, beforeLabel, afterLabel]);

  if (before.trim() === after.trim()) {
    return <div className="text-13px text-ink-2 py-16px text-center">No changes.</div>;
  }

  return <div className="rd-10px overflow-hidden border border-edge" dangerouslySetInnerHTML={{ __html: markup }} />;
}
