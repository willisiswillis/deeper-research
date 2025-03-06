import { generateObject } from 'ai';
import { z } from 'zod';

import { o3MiniModel } from './ai/providers';
import { systemPrompt } from './prompt';

export async function generateFeedback({
  query,
  numQuestions = 5,
}: {
  query: string;
  numQuestions?: number;
}) {
  const userFeedback = await generateObject({
    model: o3MiniModel,
    system: systemPrompt(),
    prompt: `You are a research-oriented AI assistant tasked with clarifying user research queries for precise information retrieval. Given the user's original query enclosed within <query></query>, generate up to ${numQuestions} targeted, insightful follow-up questions that clarify ambiguities or specify the research direction, scope, outcomes, or key parameters required. Only return fewer than ${numQuestions} if the original query is already sufficiently detailed and clear.

Structure your response as:
1. [First follow-up question]
2. [Second follow-up question]
...
N. [Nth follow-up question]

Original user query: <query>${query}</query>`,
    schema: z.object({
      questions: z
        .array(z.string())
        .describe(
          `Follow up questions to clarify the research direction, max of ${numQuestions}`,
        ),
    }),
  });

  return userFeedback.object.questions.slice(0, numQuestions);
}
