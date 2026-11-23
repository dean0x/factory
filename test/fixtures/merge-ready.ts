/**
 * Recorded answers for public merged PRs of this repository. Use `gh pr view` with the readiness field list.
 * Keep the recorded PR head. Use `gh api --method GET 'repos/OWNER/REPO/compare/BASE...HEAD?per_page=1' --jq '{behind_by}'`.
 * Use `e94aeba162892a16018ef2604b2126b77348fa63` as BASE to get the same counts after the default branch moves.
 * Omit the PR URL and head branch. Keep only the check kind, status and conclusion or state.
 * The manual verdicts describe the merged PRs, not their state before merge.
 */
const mergedAnswer = (number: number, headRefOid: string, mergedAt: string, mergeOid: string) => ({
  number,
  state: 'MERGED',
  isDraft: false,
  headRefOid,
  baseRefName: 'main',
  isCrossRepository: false,
  mergeable: 'UNKNOWN',
  mergeStateStatus: 'UNKNOWN',
  reviewDecision: '',
  mergedAt,
  mergeCommit: { oid: mergeOid },
  statusCheckRollup: [
    { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' },
  ],
});

export const recordedMergedPrs = [
  { view: mergedAnswer(86, '00888c9b5261bc94b0e8f3d2c7c142c2cf77b177', '2026-11-23T00:18:48Z', 'e94aeba162892a16018ef2604b2126b77348fa63'), compare: { behind_by: 1 } },
  { view: mergedAnswer(85, 'ff78b8e5b86f345497d739bc48296a87abf6a966', '2026-11-22T23:52:15Z', '67d4b9aa583ee51173a746ba38c168f7d967472f'), compare: { behind_by: 2 } },
  { view: mergedAnswer(84, '5393c3867547e125d92af61e46462df8712f039f', '2026-11-22T20:26:10Z', 'a406927275f15aaf3e237ead8a008fc7edcaa166'), compare: { behind_by: 3 } },
];
