import { Router, Request, Response } from "express";
import { devig, americanToProbability, probabilityToAmerican } from "../lib/quant-math";

const router = Router();

router.post("/devig", (req: Request, res: Response) => {
  try {
    const { prices, market } = req.body;
    
    if (!Array.isArray(prices) || prices.length < 2) {
      return res.status(400).json({ error: "prices must be an array of at least 2 american odds" });
    }
    
    if (!market || typeof market !== 'string') {
      return res.status(400).json({ error: "market string is required" });
    }

    const deviggedProbs = devig(prices, market);
    const deviggedAmerican = deviggedProbs.map(probabilityToAmerican);

    res.json({
      input: prices,
      market,
      impliedProbabilities: prices.map(americanToProbability),
      deviggedProbabilities: deviggedProbs,
      deviggedAmerican: deviggedAmerican
    });
  } catch (err: any) {
    res.status(500).json({ error: "Math computation failed", detail: err.message });
  }
});

export default router;
