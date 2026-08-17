import { TransitProvider } from './TransitProvider';
import { MartaAdapter } from './adapters/MartaAdapter';
import { WmataAdapter } from './adapters/WmataAdapter';
import { CtaAdapter } from './adapters/CtaAdapter';
import { MtaAdapter } from './adapters/MtaAdapter';
import { TflAdapter } from './adapters/TflAdapter';

const REGISTRY: Record<string, TransitProvider> = {
  marta: new MartaAdapter(),
  wmata: new WmataAdapter(process.env.WMATA_API_KEY ?? ''),
  cta: new CtaAdapter(process.env.CTA_API_KEY ?? ''),
  mta: new MtaAdapter(process.env.MTA_API_KEY ?? ''),
  tfl: new TflAdapter(process.env.TFL_APP_ID, process.env.TFL_APP_KEY),
};

export function getProvider(agencyId: string): TransitProvider {
  const provider = REGISTRY[agencyId];
  if (!provider) throw new Error(`No adapter registered for agency: ${agencyId}`);
  return provider;
}
