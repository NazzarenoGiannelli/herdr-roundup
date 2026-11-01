// The gh GraphQL queries (the test fixtures were captured with exactly these) and the search
// strings that feed them. Do not add `mergeable` to the list queries: with it GitHub failed the
// call on 2026-10-31 (HTML error body). The only import is ./config.js: Node tests read this file too.
import { DEFAULT_MERGED_DAYS } from "./config.js";

// The listed owners as search qualifiers: `owner:a owner:b` matches either.
export const ownerTerms = (owners) => owners.map((o) => `owner:${o}`).join(" ");
export const prSearch = (owners) => `${ownerTerms(owners)} is:pr is:open sort:updated-desc`;
export const issueSearch = (owners) => `${ownerTerms(owners)} is:issue is:open sort:updated-desc`;

export const PR_LIST = "query($q:String!){search(query:$q,type:ISSUE,first:100){issueCount nodes{... on PullRequest{number title url isDraft updatedAt headRefName baseRefName reviewDecision author{login avatarUrl(size:64)} repository{nameWithOwner} labels(first:15){nodes{name}} commits(last:1){nodes{commit{statusCheckRollup{state}}}} comments(last:5){nodes{author{login avatarUrl(size:64)} createdAt bodyText}}}}}}";

export const ISSUE_LIST = "query($q:String!){search(query:$q,type:ISSUE,first:100){issueCount nodes{... on Issue{number title url updatedAt author{login avatarUrl(size:64)} repository{nameWithOwner} labels(first:20){nodes{name}}}}}}";

export const PR_DETAIL = "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){isDraft headRefName baseRefName headRefOid body mergeable mergeStateStatus additions deletions changedFiles commits(last:1){nodes{commit{statusCheckRollup{state contexts(first:100){totalCount nodes{__typename ... on CheckRun{name conclusion status} ... on StatusContext{context state}}}}}}} timelineItems(last:100,itemTypes:[ISSUE_COMMENT,PULL_REQUEST_REVIEW,LABELED_EVENT]){nodes{__typename ... on IssueComment{author{login avatarUrl(size:64)} createdAt body} ... on PullRequestReview{author{login avatarUrl(size:64)} createdAt body state} ... on LabeledEvent{actor{login} createdAt label{name}}}}}}}";

export const ISSUE_DETAIL = "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){body timelineItems(last:100,itemTypes:[ISSUE_COMMENT,LABELED_EVENT]){nodes{__typename ... on IssueComment{author{login avatarUrl(size:64)} createdAt body} ... on LabeledEvent{actor{login} createdAt label{name}}}}}}}";

// The "Merged" view: pull requests merged in the last `days` days (a read-only look back).
// `merged:` takes a day; the panel sorts the rows by mergedAt itself (search cannot).
export const mergedSearch = (owners, days = DEFAULT_MERGED_DAYS, now = Date.now()) =>
  `${ownerTerms(owners)} is:pr is:merged merged:>=${new Date(now - days * 86400000).toISOString().slice(0, 10)} sort:updated-desc`;
export const MERGED_LIST = PR_LIST.replace("isDraft updatedAt", "isDraft updatedAt mergedAt mergedBy{login} mergeCommit{parents{totalCount}}");

// Last merged PR into a base branch: how it was merged tells the repository's habit.
export const LAST_MERGED = "query($owner:String!,$name:String!,$base:String!){repository(owner:$owner,name:$name){pullRequests(states:MERGED,baseRefName:$base,last:1,orderBy:{field:UPDATED_AT,direction:ASC}){nodes{mergeCommit{parents{totalCount}}}}}}";
