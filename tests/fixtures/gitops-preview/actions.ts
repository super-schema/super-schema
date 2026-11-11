const reply = async () => ({ error: "Preview only; no remote mutation" });
export {
  reply as gitOpsWorkspaceAction,
  reply as saveGitOpsAppAction,
  reply as saveGitOpsBindingAction,
  reply as saveGitOpsProductAction,
  reply as bootstrapGitOpsAction,
  reply as saveGitOpsDraftAction,
  reply as submitGitOpsAction,
  reply as refreshGitOpsDraftAction,
  reply as discardGitOpsAction,
  reply as promoteGitOpsAction,
  reply as promoteGitOpsEnvironmentAction,
  reply as syncGitOpsAction,
  reply as retryGitOpsJobAction,
  reply as unlinkGitHubAction,
  reply as rebuildGitOpsAction,
};
