export interface Attachment {
  contentType: string | null;
  name: string | null;
  size: number;
  url: string;
}

export interface ResolveResult {
  prompt: string | null;
  error: string | null;
}

const MAX_ATTACHMENT_SIZE = 100 * 1024; // 100KB

function isTextAttachment(attachment: Attachment): boolean {
  if (attachment.contentType?.startsWith('text/')) return true;
  if (attachment.name?.endsWith('.txt')) return true;
  return false;
}

export type FetchFn = (url: string) => Promise<string>;

async function defaultFetch(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.text();
}

export async function resolvePrompt(
  content: string,
  attachments: Attachment[],
  fetchFn: FetchFn = defaultFetch,
): Promise<ResolveResult> {
  const textAttachment = attachments.find(isTextAttachment);

  if (!textAttachment) {
    return { prompt: content || null, error: null };
  }

  if (textAttachment.size > MAX_ATTACHMENT_SIZE) {
    return {
      prompt: content || null,
      error: `添付ファイルが大きすぎます（${Math.round(textAttachment.size / 1024)}KB、最大 100KB）`,
    };
  }

  try {
    const text = await fetchFn(textAttachment.url);
    const combined = content ? `${content}\n\n${text}` : text;
    return { prompt: combined || null, error: null };
  } catch (err) {
    console.error('Attachment download error:', err);
    return { prompt: content || null, error: null };
  }
}
