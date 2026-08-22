import { LogOut } from 'lucide-react';
import BondPolicyCampaignWorkspace from '../../components/bond/BondPolicyCampaignWorkspace';
import { useAuth } from '../../contexts/AuthContext';

export default function FranchiseBondCampaignManager() {
  const { staffProfile, logout } = useAuth();
  return (
    <main className="min-h-[100dvh] bg-[#f7f1ea] px-4 py-5 text-neutral-900 md:px-6">
      <div className="mx-auto mb-4 flex max-w-7xl items-center justify-between gap-4">
        <div>
          <p className="font-black text-[#3e2723]">Coffee Bond</p>
          <p className="text-xs font-bold text-neutral-500">{staffProfile?.displayName} · assigned-store campaign workspace</p>
        </div>
        <button onClick={() => void logout()} className="inline-flex h-10 items-center gap-2 rounded-xl border border-[#d8c8b8] bg-white px-3 text-sm font-black text-[#5c4033]">
          <LogOut size={16} /> Sign out
        </button>
      </div>
      <BondPolicyCampaignWorkspace mode="FRANCHISE_MANAGER" />
    </main>
  );
}
