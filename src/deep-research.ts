import FirecrawlApp, { SearchResponse } from '@mendable/firecrawl-js';
import { generateObject } from 'ai';
import { compact } from 'lodash-es';
import pLimit from 'p-limit';
import { z } from 'zod';

import { o3MiniModel, trimPrompt } from './ai/providers';
import { OutputManager } from './output-manager';
import { systemPrompt } from './prompt';

// Initialize output manager for coordinated console/progress output
const output = new OutputManager();

// Replace console.log with output.log
function log(...args: any[]) {
  output.log(...args);
}

export type ResearchProgress = {
  currentDepth: number;
  totalDepth: number;
  currentBreadth: number;
  totalBreadth: number;
  currentQuery?: string;
  totalQueries: number;
  completedQueries: number;
};

type ResearchResult = {
  learnings: string[];
  visitedUrls: string[];
};

// increase this if you have higher API rate limits
const ConcurrencyLimit = 4;

// Initialize Firecrawl with optional API key and optional base url

const firecrawl = new FirecrawlApp({
  apiKey: process.env.FIRECRAWL_KEY ?? '',
  apiUrl: process.env.FIRECRAWL_BASE_URL,
});

// take a user query and optional previous learnings, return detailed SERP queries suited for deep research
async function generateSerpQueries({
  query,
  numQueries = 3,
  learnings,
}: {
  query: string;
  numQueries?: number;
  // Optional context: specified previous learnings and insights from earlier research sessions
  learnings?: string[];
}) {
  const res = await generateObject({
    model: o3MiniModel,
    system: systemPrompt(),
    prompt: `
You are an expert research assistant specialized in comprehensive, precise, and thorough research support, assisting a highly experienced analyst.  
Today's task: Given the user's original research prompt, generate a set of targeted, highly practical, and precisely worded Search Engine Results Page (SERP) queries designed to maximize research depth, breadth, accuracy, and innovation on the subject described.

## Your explicit instructions are:

1. Carefully analyze the user's input prompt enclosed within <prompt></prompt>, clearly identifying essential subject dimensions, relevant contexts, research angles, innovative perspectives, and unexplored directions that will best facilitate an exhaustive, rigorous understanding of the topic.

2. Generate up to ${numQueries} clearly differentiated, explicitly unique, and targeted SERP queries. These queries must:
   - Be carefully crafted and deliberately distinct from one another, explicitly avoiding redundancy or similarity.
   - Clearly address unique and specific research angles, subtopics, emerging trends, contrarian views, innovative approaches, or speculative ideas that could significantly enhance the comprehensiveness of the overall research.
   - Proactively suggest insightful queries beyond what the user explicitly provided, demonstrating anticipation of user needs and thoughtful innovation.

3. Provide fewer than ${numQueries} queries only if the original prompt already sufficiently covers a narrow and clearly defined research scope, eliminating the necessity for additional distinct queries.

4. Structure your response clearly with numbered formatting and explicit rationale details for transparency:
   1. [First explicitly worded search query] (Explicit rationale explaining the strategic choice of this query, clearly articulating unique content or angle addressed, e.g., "This query targets emerging technology XYZ to explore its potential future implications in ...").
   2. [Second explicitly worded search query] (Clear and explicit rationale as above)
   ...
   N. [Nth explicitly worded search query] (Clear rationale as above)

5. Identify explicitly speculative or highly innovative queries as "**Speculative Query**" clearly within your justification when relevant, ensuring transparency and awareness.

## User-provided Original Prompt:
<prompt>${query}</prompt>

${
  learnings && learnings.length
    ? `
## Previous Research Learnings provided (Use these explicitly to enhance specificity, focus within sub-areas, or refine queries):
${learnings.map((l, idx) => `${idx + 1}. ${l}`).join('\n')}`
    : '## No previous research learnings provided. Feel free to establish broad yet explicitly precise foundational queries.'
}

## Required response schema explanation:
- 'query': Clearly articulated SERP query text.
- 'researchGoal': Clearly and explicitly state the primary goal or objective behind each query. Then, explicitly outline potential next steps in research upon obtaining results, mentioning specific future research directions, sub-queries, or innovative angles for continued exploration. Be comprehensive, specific, and detailed with practical recommendations.

Prioritize detail, precision, accuracy, innovation, user anticipation, and transparency in your final outputs. Length of explanation and rationale is encouraged; err on the side of comprehensiveness.
`,
    schema: z.object({
      queries: z
        .array(
          z.object({
            query: z
              .string()
              .describe(
                'The explicitly worded, targeted SERP query designed for maximum precision and clarity.',
              ),
            researchGoal: z
              .string()
              .describe(
                'Explicitly state the main research intent behind this query. Then clearly outline detailed next steps and specific subsequent research directions after the query results are obtained. Include clearly explained suggestions for further innovative and targeted exploration paths.',
              ),
          }),
        )
        .describe(
          `A precisely crafted list of SERP queries, with a maximum total of ${numQueries}`,
        ),
    }),
  });

  log(`Created ${res.object.queries.length} SERP queries`, res.object.queries);

  return res.object.queries.slice(0, numQueries);
}

async function processSerpResult({
  query,
  result,
  numLearnings = 5,
  numFollowUpQuestions = 5,
}: {
  query: string;
  result: SearchResponse;
  numLearnings?: number;
  numFollowUpQuestions?: number;
}) {
  const contents = compact(result.data.map(item => item.markdown)).map(
    content => trimPrompt(content, 25_000),
  );
  log(
    `Ran SERP query "${query}", found ${contents.length} usable content entries`,
  );

  const res = await generateObject({
    model: o3MiniModel,
    abortSignal: AbortSignal.timeout(60_000),
    system: systemPrompt(),
    prompt: `
You are a rigorous and expert-level research assistant working alongside a highly experienced analyst. Your goal is explicitly clear: Given the SERP search results for the original query provided within <query></query>, meticulously analyze the provided contents to summarize actionable research insights ("learnings") and proactively identify precise and explicitly detailed follow-up questions for deeper research.

## Task instructions:

### PART 1: Summarization of SERP Contents into Explicit Research Learnings (Insights)
- Examine each provided piece of content closely.
- Generate up to ${numLearnings} explicitly unique, distinct, specific, and actionable learnings from the SERP contents.
- Each learning must:
  - Be precise, information-dense, and clearly stated while remaining concise and direct.
  - Explicitly include key entities (names of people, organizations, products, places), numeric metrics, detailed statistics, percentages, dates, and any other relevant precise factual data.
  - Clearly address distinct aspects and avoid overlap or similarity with other learnings.
- Return fewer learnings if contents are already clearly summarized or limited in breadth, making additional learnings unnecessary.

### PART 2: Generation of Explicit Follow-Up Research Questions
- Proactively generate up to ${numFollowUpQuestions} explicitly stated, precise, distinctly useful follow-up questions.
- These follow-up questions must be formulated explicitly to enable clear, actionable next steps in continued research.
- Clearly indicate different angles, unexplored dimensions, comparative evaluations, deeper analyses, or speculative explorations that could significantly advance understanding or further analysis of the subject.
- Return fewer questions only if the provided research contents are sufficiently detailed and no additional follow-up questions add significant value.

## Clear Response Structure Required:
Ensure your structured response is clearly formatted and numbered explicitly as follows:

### Learnings:
1. Explicit and precise first learning summary (entity names, numeric data & specific key insights)
2. Explicit second learning summary (entity names, distinct facts & metrics)
...
N. Nth explicit learning (clearly distinct insights, names, numbers, dates as applicable)

### Follow-Up Research Questions:
1. Explicit and proactive first follow-up question (clear rationale or specific gap addressed)
2. Explicit and distinct second follow-up question (specific dimension or new angle explored)
...
M. Mth explicit follow-up question (clearly justified for deeper exploration or speculative potential labeled as **Speculative**, if relevant)

## Original SERP Query Provided:
<query>${query}</query>

## SERP Contents for Analysis:
<contents>
${contents.map(content => `<content>\n${content}\n</content>`).join('\n')}
</contents>

Your generated response must err explicitly on the side of clarity, detail, precision, innovation, and proactive anticipation of user research directions and future exploration needs.
`,
    schema: z.object({
      learnings: z
        .array(z.string())
        .describe(
          `Explicitly detailed and concise list of learnings (insight summaries), maximum total of ${numLearnings}. Each learning explicitly contains key entities, metrics, numeric details, dates, or precision factual insights.`,
        ),

      followUpQuestions: z
        .array(z.string())
        .describe(
          `Explicitly proactive, precise, actionable follow-up research questions designed to foster further deep, innovative, or exploratory research directions. Maximum total of ${numFollowUpQuestions}.`,
        ),
    }),
  });

  log(
    `Created ${res.object.learnings.length} explicit learnings and ${res.object.followUpQuestions.length} explicit follow-up questions`,
    {
      learnings: res.object.learnings,
      followUpQuestions: res.object.followUpQuestions,
    },
  );

  return res.object;
}

export async function writeFinalReport({
  prompt,
  learnings,
  visitedUrls,
}: {
  prompt: string;
  learnings: string[];
  visitedUrls: string[];
}) {
  const learningsString = trimPrompt(
    learnings
      .map(learning => `<learning>\n${learning}\n</learning>`)
      .join('\n'),
    25000, // adjust as per optimal token/performance limits
  );

  const res = await generateObject({
    model: o3MiniModel,
    abortSignal: AbortSignal.timeout(120_000), // increased timeout to handle detailed reports
    system: systemPrompt(),
    prompt: `
You are an expert research assistant working collaboratively with a senior analyst. Your goal is explicit—produce a detailed, rigorously structured, highly comprehensive final research report on a clearly defined research prompt, thoroughly integrating all provided learnings from previous search-driven research.

## Explicitly Defined Task:

Generate an expert-level, meticulously detailed, highly structured research report on the provided topic. You must explicitly:

- Integrate ALL provided research learnings thoroughly into your final report without omission. Do not leave out meaningful details or data points.
- Aim explicitly for a minimum length of 3 to 5 pages (or more if necessary to clearly and exhaustively cover the subject).
- Maintain optimal readability by clearly dividing the report into logical sections and subsections featuring clearly labeled headings and subheadings.
- Emphasize clarity, brevity, accuracy, logical coherence, proactive anticipation of user needs, and explicit rigor in logical argumentation.
- Clearly mark speculative analyses, future predictions, or innovative recommendations explicitly as speculative (e.g., "**Speculative:** ...").

## Referencing and Sources:

- Explicitly cite all references and sources inline exactly where data, quotes, or assertions appear within the written report. Inline citations must precisely provide complete citation details (author/title/source, date/year, DOI or URL when appropriate).
- Conclude your report with a clearly labeled and neatly formatted "Sources and References" section, explicitly summarizing all citations and references used, formatted clearly for reference convenience.

## Length and Detail Expectation:

- The final report should aim explicitly for a detailed depth, approximately equivalent to 3 or more printed pages or approximately ~1500-3000 words (flexible, prioritize thoroughness and accuracy over brevity).
- Err explicitly toward thoroughness, comprehensiveness, explicit clarity, and practical insight over brevity or minimalism. Leaving out critical details or learnings will significantly erode user trust.

## Original Research Prompt from user:
<prompt>${prompt}</prompt>

## Provided Research Learnings (ALL must be explicitly integrated):
<learnings>
${learningsString}
</learnings>

`,
    schema: z.object({
      reportMarkdown: z
        .string()
        .describe(
          'Comprehensively structured and explicitly detailed Markdown-formatted research report integrating all presented learnings, inline citations, explicitly flagged speculation, and a references section.',
        ),
    }),
  });

  // Ensure a clearly delineated and formatted "Sources and References" section
  const sourcesSection = `
  
## Sources and References:
${visitedUrls.map(url => `- ${url}`).join('\n')}
`;

  log('Final Report Generated', {
    length: res.object.reportMarkdown.length,
    numLearningsIntegrated: learnings.length,
    numVisitedSources: visitedUrls.length,
  });

  return res.object.reportMarkdown + sourcesSection;
}

export async function deepResearch({
  query,
  breadth,
  depth,
  learnings = [],
  visitedUrls = [],
  onProgress,
}: {
  query: string;
  breadth: number;
  depth: number;
  learnings?: string[];
  visitedUrls?: string[];
  onProgress?: (progress: ResearchProgress) => void;
}): Promise<ResearchResult> {
  const progress: ResearchProgress = {
    currentDepth: depth,
    totalDepth: depth,
    currentBreadth: breadth,
    totalBreadth: breadth,
    totalQueries: 0,
    completedQueries: 0,
  };

  const reportProgress = (update: Partial<ResearchProgress>) => {
    Object.assign(progress, update);
    onProgress?.(progress);
  };

  const serpQueries = await generateSerpQueries({
    query,
    learnings,
    numQueries: breadth,
  });

  reportProgress({
    totalQueries: serpQueries.length,
    currentQuery: serpQueries[0]?.query,
  });

  const limit = pLimit(ConcurrencyLimit);

  const results = await Promise.all(
    serpQueries.map(serpQuery =>
      limit(async () => {
        try {
          const result = await firecrawl.search(serpQuery.query, {
            timeout: 15000,
            limit: 5,
            scrapeOptions: { formats: ['markdown'] },
          });

          // Collect URLs from this search
          const newUrls = compact(result.data.map(item => item.url));
          const newBreadth = Math.ceil(breadth / 2);
          const newDepth = depth - 1;

          const newLearnings = await processSerpResult({
            query: serpQuery.query,
            result,
            numFollowUpQuestions: newBreadth,
          });
          const allLearnings = [...learnings, ...newLearnings.learnings];
          const allUrls = [...visitedUrls, ...newUrls];

          if (newDepth > 0) {
            log(
              `Researching deeper, breadth: ${newBreadth}, depth: ${newDepth}`,
            );

            reportProgress({
              currentDepth: newDepth,
              currentBreadth: newBreadth,
              completedQueries: progress.completedQueries + 1,
              currentQuery: serpQuery.query,
            });

            const nextQuery = `
            Previous research goal: ${serpQuery.researchGoal}
            Follow-up research directions: ${newLearnings.followUpQuestions.map(q => `\n${q}`).join('')}
          `.trim();

            return deepResearch({
              query: nextQuery,
              breadth: newBreadth,
              depth: newDepth,
              learnings: allLearnings,
              visitedUrls: allUrls,
              onProgress,
            });
          } else {
            reportProgress({
              currentDepth: 0,
              completedQueries: progress.completedQueries + 1,
              currentQuery: serpQuery.query,
            });
            return {
              learnings: allLearnings,
              visitedUrls: allUrls,
            };
          }
        } catch (e: any) {
          if (e.message && e.message.includes('Timeout')) {
            log(`Timeout error running query: ${serpQuery.query}: `, e);
          } else {
            log(`Error running query: ${serpQuery.query}: `, e);
          }
          return {
            learnings: [],
            visitedUrls: [],
          };
        }
      }),
    ),
  );

  return {
    learnings: [...new Set(results.flatMap(r => r.learnings))],
    visitedUrls: [...new Set(results.flatMap(r => r.visitedUrls))],
  };
}
