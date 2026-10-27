/** Lightweight browser cleanup: shared navigation must not load the wizard's validation/transport graph. */
export const WIZARD_RECOVERY_PREFIX = 'raid-wizard-recovery-v1:';
type Store = Pick<Storage, 'removeItem' | 'key' | 'length'>;
export function clearAllWizardRecovery(store: Store) {
  store.removeItem('raid-wizard-form-v1');
  for (let i = store.length - 1; i >= 0; i--) {
    const key = store.key(i);
    if (key?.startsWith(WIZARD_RECOVERY_PREFIX)) store.removeItem(key);
  }
}
