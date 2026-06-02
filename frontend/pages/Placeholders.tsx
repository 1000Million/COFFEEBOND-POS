import React from 'react';
import KOTScreen from './kot/KOTScreen';

export function KOTBarista() {
  return <KOTScreen station="BARISTA" />;
}

export function KOTKitchen() {
  return <KOTScreen station="KITCHEN" />;
}
