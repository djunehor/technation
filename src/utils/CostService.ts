import fs from 'fs';
import path from 'path';
import type { LLMUsage } from '../types/index.js';
import { Logger } from './logger.js';

export class CostService {
  private static prices: Record<string, any> | null = null;

  private static loadPrices() {
    if (this.prices) return;
    try {
      const filePath = path.join(process.cwd(), 'data', 'model_prices.json');
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf-8');
        this.prices = JSON.parse(content);
      } else {
        Logger.warn('model_prices.json not found in data/. Cost estimation will be disabled.');
        this.prices = {};
      }
    } catch (e) {
      Logger.error('Failed to load model_prices.json:', e);
      this.prices = {};
    }
  }

  /**
   * Calculates the USD cost of an LLM operation.
   * Logic: (CacheMissInput * InputPrice) + (CacheHitInput * CacheReadPrice) + (Output * OutputPrice)
   */
  static calculateCost(model: string, usage: LLMUsage): number {
    this.loadPrices();
    if (!this.prices) return 0;

    // LiteLLM often uses different names or internal mapping, but let's try direct match first
    const modelData = this.prices[model];
    if (!modelData) {
      // Try to find a partial match (e.g. gpt-4o vs gpt-4o-2024-05-13)
      const likelyKey = Object.keys(this.prices).find(k => model.startsWith(k) || k.startsWith(model));
      if (!likelyKey) return 0;
      return this.calculateCostFromData(this.prices[likelyKey], usage);
    }

    return this.calculateCostFromData(modelData, usage);
  }

  private static calculateCostFromData(data: any, usage: LLMUsage): number {
    const inputPrice = data.input_cost_per_token || 0;
    const outputPrice = data.output_cost_per_token || 0;
    const cacheHitPrice = data.cache_read_input_token_cost || (inputPrice / 2); // Fallback to 50% discount if not specified

    const inputCost = (usage.cacheMissTokens || usage.inputTokens) * inputPrice;
    const cacheHitCost = (usage.cacheHitTokens || 0) * cacheHitPrice;
    const outputCost = usage.outputTokens * outputPrice;

    return inputCost + cacheHitCost + outputCost;
  }
}
