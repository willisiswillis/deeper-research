import FirecrawlApp, { SearchResponse } from '@mendable/firecrawl-js';
import { generateObject, LanguageModelV1 } from 'ai';
import { compact } from 'lodash-es';
import pLimit from 'p-limit';
import { z } from 'zod';

import { claude37Model, o3MiniModel, trimPrompt } from './ai/providers';
import { OutputManager } from './output-manager';
import { systemPrompt } from './prompt';

// Initialize output manager for coordinated console/progress output
const output = new OutputManager();

// Replace console.log with output.log
function log(...args: any[]) {
  output.log(...args);
}

// Define model to use based on env vars
const model = process.env.USE_CLUADE ? claude37Model : o3MiniModel;

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
    model: model,
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
    content => trimPrompt(content, 50_000),
  );
  log(
    `Ran SERP query "${query}", found ${contents.length} usable content entries`,
  );

  const res = await generateObject({
    model: model,
    abortSignal: AbortSignal.timeout(120_000),
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
    50000, // deliberately chosen optimal token/performance boundary
  );

  const res = await generateObject({
    model: model,
    abortSignal: AbortSignal.timeout(120_000), // provides ample time for detailed response generation
    system: systemPrompt(),
    prompt: `
You are an expert research assistant working closely with a senior analyst. Your task is to prepare a detailed, authoritative, rigorously structured, and comprehensive research report based on the provided prompt and carefully integrating all provided research learnings.

Your report must adhere exactly to the following explicit guidelines and requirements:

## Task Definition:

Write a thoroughly detailed, highly structured, and professional research report clearly addressing the provided research prompt enclosed within <prompt></prompt>. Your report must explicitly prioritize practical applications and suggest contextually relevant courses of action derived objectively from the research findings unless the prompt explicitly specifies a purely theoretical scope.

## Explicit Content Requirements:

1. Clearly integrate all the provided learnings without omission or summarization that omits meaningful details, data points, specific entities (persons, organizations, locations, products, etc.), or explicit metrics (numbers, dates, statistics).
2. Include careful and explicit citation of all sources inline exactly at points of data usage, quotes, assertions, and claims. Inline citations must include detailed references (author, title or source name, publication date or year, exact DOI or URL when available).
3. Clearly identify speculative analyses, predictions, innovative ideas, or unverified recommendations explicitly as speculative or hypothesis-driven (for example: "**Speculative:** [...]").
4. Your final report must clearly anticipate user needs, offering suggestions and insights of additional valuable research directions proactively where relevant.

## Explicit Report Structure:

The final report must feature clearly labeled headings organized explicitly in the following structure (or a highly similar logical outline clearly optimized for readability and comprehensiveness):

## Title

### Introduction  
Clearly define and restate the objective, scope, and any explicit context required based on original user prompt.

### Key Insights and Findings  
Clearly summarize all explicit research learnings provided. Ensure explicit detail, including entities, numeric metrics, specific dates, key statistics, and essential facts. Clearly integrate and explicitly cite inline references.

### Analysis and Discussion  
Explicitly analyze, interpret, and discuss the significance and implications of each previously captured learning. 
- Clearly mark speculative or innovative insights explicitly as "Speculative".
- Provide rigorous analytical details, explicitly supporting arguments logically rather than appealing purely to source authority.

### Practical Applications and Recommended Course of Action (unless explicitly noted as theoretical only in the prompt)  
Explicitly and clearly outline a set of practical, thoroughly actionable recommendations or strategic courses of action directly informed by the learnings and analysis.
- Include specific practical steps clearly and explicitly where applicable, proactively anticipating implementation details that might meaningfully benefit the user's understanding or practical application of the research.

### Conclusion  
Clearly restate essential findings and explicitly summarize core recommendations and the explicitly defined next-steps emerging from your detailed analysis and research.

### Sources and References  
Clearly formatted final summary list of all explicitly cited sources included inline. Include complete details (author/title/source, date/year, DOI or URL).

## Explicit Length, Depth, and Detail Expectations:

- The report must explicitly strive for depth and comprehensiveness, equivalent to 3+ printed pages (~1500-3000 words minimum). Prioritize explicit thoroughness and detail over brevity. Longer reports are acceptable if necessary for thoroughness.
- Meticulously proofread content for factual accuracy, spelling, grammar, coherence, and professional readability.
- Errors significantly erode user trust; explicitly verify factual accuracy and precision.

## Original User Prompt Provided:
<prompt>${prompt}</prompt>

## Research Learnings Provided (ALL explicitly required to be integrated comprehensively and accurately):
<learnings>
${learningsString}
</learnings>
`,
    schema: z.object({
      reportMarkdown: z
        .string()
        .describe(
          'Detailed, comprehensively structured Markdown-formatted research report integrating clearly articulated analysis, explicitly inclusive of all provided learnings, explicitly cited references inline, proactive research direction suggestions, explicitly flagged speculative analyses (as appropriate), practical recommendations, actionable course of action section, and clearly delineated Sources and References section.',
        ),
    }),
  });

  const sourcesSection = `\n\n## Sources and References\n\n${visitedUrls
    .map(url => `- ${url}`)
    .join('\n')}`;

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
            timeout: 45000,
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
