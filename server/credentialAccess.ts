export function isCredentialAdmin(uid: string | undefined, configuredUids = process.env.LOHZ_CREDENTIAL_ADMIN_UIDS): boolean {
  if (!uid || !configuredUids) return false;
  return configuredUids.split(",").map((value) => value.trim()).filter(Boolean).includes(uid);
}
