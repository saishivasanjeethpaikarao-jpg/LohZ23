export interface UpdatePolicyInput { packaged: boolean; signedRelease: boolean; updateUrl?: string; platform?: string; }
export function evaluateUpdatePolicy(input: UpdatePolicyInput): { enabled: boolean; reason: string } {
  if (!input.packaged) return { enabled: false, reason: "development_build" };
  if (!input.signedRelease) return { enabled: false, reason: "unsigned_release" };
  if (!input.updateUrl || !/^https:\/\//i.test(input.updateUrl)) return { enabled: false, reason: "secure_update_url_required" };
  if (input.platform === "linux") return { enabled: false, reason: "linux_package_updates_are_manual" };
  return { enabled: true, reason: "signed_https_updates_enabled" };
}
