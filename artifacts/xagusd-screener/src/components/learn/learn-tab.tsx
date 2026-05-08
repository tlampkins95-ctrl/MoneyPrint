import { PivotFormula } from "./pivot-formula";
import { ZoneDiagram } from "./zone-diagram";
import { GatesChecklist } from "./gates-checklist";
import { TradeDiagram } from "./trade-diagram";

export function LearnTab() {
  return (
    <div className="max-w-3xl mx-auto space-y-12 py-6 px-2">
      <div className="text-center space-y-2">
        <h1
          className="text-white text-2xl font-bold tracking-[0.18em] uppercase"
          style={{ fontFamily: "var(--app-font-display)" }}
        >
          PIVOT BOUNCE — HOW IT WORKS
        </h1>
        <p className="text-[#8b949e] text-sm max-w-lg mx-auto">
          A mean-reversion strategy anchored to daily pivot levels. Four diagrams
          cover the full signal logic from formula to trade setup.
        </p>
      </div>

      <section>
        <PivotFormula />
      </section>

      <div className="border-t border-[#30363d]" />

      <section>
        <ZoneDiagram />
      </section>

      <div className="border-t border-[#30363d]" />

      <section>
        <GatesChecklist />
      </section>

      <div className="border-t border-[#30363d]" />

      <section>
        <TradeDiagram />
      </section>
    </div>
  );
}
