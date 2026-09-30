import { requireUser } from '@/lib/auth';
import { usdcSettings, quoteUsdc } from '@/lib/usdc';
import { failure } from '@/lib/http';
export async function GET(request: Request) {
  try {
    await requireUser();
    const settings = usdcSettings();
    return Response.json({
      rate: settings.rateUnits?.toString() || null,
      units: settings.rateUnits
        ? quoteUsdc(
            Number(new URL(request.url).searchParams.get('target')),
            settings.rateUnits,
          ).toString()
        : null,
    });
  } catch (error) {
    return failure(error);
  }
}
