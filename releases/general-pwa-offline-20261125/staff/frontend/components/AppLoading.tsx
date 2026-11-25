import React from 'react';
import { Loader2 } from 'lucide-react';

export default function AppLoading() {
  return (
    <div className="min-h-screen bg-[#f9f5f0] flex flex-col items-center justify-center p-4">
      <Loader2 size={32} className="animate-spin text-[#5c4033] mb-4" />
      <span className="text-[#5c4033] font-medium animate-pulse">Loading Coffee Bond POS...</span>
    </div>
  );
}
