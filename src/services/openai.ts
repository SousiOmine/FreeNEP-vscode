import OpenAI from 'openai';

export async function requestCompletion(params: {
  baseURL: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  signal?: AbortSignal;
}): Promise<string> {
  const { baseURL, apiKey, model, systemPrompt, userPrompt, signal } = params;
  const client = new OpenAI({ apiKey, baseURL });
  try {
    const completion = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.2,
    }, { signal });
    return completion.choices?.[0]?.message?.content ?? '';
  } catch (err: any) {
    const name = err?.name as string | undefined;
    const msg = err?.message as string | undefined;
    const aborted = name === 'AbortError' || name === 'APIUserAbortError' || (typeof msg === 'string' && msg.toLowerCase().includes('aborted'));
    if (aborted) {
      const e = new Error('Aborted');
      e.name = 'AbortError';
      throw e;
    }
    throw err;
  }
}
