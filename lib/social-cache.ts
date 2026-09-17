// Shared cache rows contain public evidence only, never request/account state.
// Project legacy rows too: previously they included the requesting user's quota.
export function publicSocialEvidence(value: any) {
  return {
    address: value.address,
    posts: Array.isArray(value.posts) ? value.posts.map((post: any) => ({
      text: post.text, date: post.date, url: post.url, author: post.author,
    })) : [],
    ...(value.summary ? {summary: {
      sampleSize: value.summary.sampleSize,
      uniqueAuthors: value.summary.uniqueAuthors,
      duplicateText: value.summary.duplicateText,
      engagement: value.summary.engagement,
      warning: value.summary.warning,
    }} : {}),
    asOf: value.asOf,
  };
}

export const socialEvidenceMessage = 'Up to 25 recent posts containing this exact contract. Social evidence does not override market or safety flags.';
