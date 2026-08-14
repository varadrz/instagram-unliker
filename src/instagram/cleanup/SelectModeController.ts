import { waitForDomReady, waitForPageIdle } from '../../browser/waits.js';
import { clickByLabels } from '../clickByLabels.js';
import type { CleanupContext } from './CleanupContext.js';
import { hasVisibleSelectionControl } from './browser/hasVisibleSelectionControl.js';
import { getSelectableItemsSelector, getSelectionModeSelector } from './selectors.js';
import { getTranslationValues } from '../../translations/loadTranslations.js';
import { uniqueStrings } from '../../utils/text.js';

const maxSelectModeAttempts = 3;
const selectModeRefreshTimeoutMs = 90_000;

export class SelectModeController {
  public constructor(private readonly context: CleanupContext) {}

  public async ensure(): Promise<void> {
    for (let attempt = 1; attempt <= maxSelectModeAttempts; attempt += 1) {
      if (this.context.target.mode === 'likes' && !this.context.sortApplied) {
        if (await this.isActive()) {
          this.context.debug('Selection mode is active but sort is not applied. Deactivating selection mode first.');
          await this.deactivateSelectionMode();
        }

        const sortApplied = await this.applyOldestToNewestSort();
        if (!sortApplied) {
          throw new Error('Failed to apply "Oldest to newest" sort. Aborting cleanup to prevent unsorted operations.');
        }
        this.context.sortApplied = true;
      }

      if (await this.isActive()) {
        return;
      }

      const selected = await clickByLabels(this.context.page, this.context.target.selectLabels, {
        timeout: 10_000,
        exact: true,
        includeTextElements: true,
        waitAfterClickTimeout: 750,
        waitAfterClickIdleTime: 150,
        debugName: 'Select',
      });

      if (!selected) {
        await this.refreshBeforeRetry(attempt, 'The Select button was not found yet.');
        continue;
      }

      const selectionDetected = await this.waitForSelectionMode();

      if (selectionDetected || (await this.hasSelectableItems())) {
        return;
      }

      await this.refreshBeforeRetry(attempt, 'Selection mode was not detected yet.');
    }

    throw new Error('The Select button was not found after refreshing the page.');
  }

  private async isActive(): Promise<boolean> {
    return this.context.page.evaluate(hasVisibleSelectionControl, getSelectionModeSelector());
  }

  private async hasSelectableItems(): Promise<boolean> {
    return this.context.page.evaluate(hasVisibleSelectionControl, getSelectableItemsSelector());
  }

  private async waitForSelectionMode(): Promise<boolean> {
    return this.context.page
      .waitForFunction(
        hasVisibleSelectionControl,
        { timeout: 1_200, polling: 100 },
        getSelectionModeSelector(),
      )
      .then(async (handle) => {
        await handle.dispose();
        return true;
      })
      .catch(() => false);
  }

  private async refreshBeforeRetry(attempt: number, reason: string): Promise<void> {
    if (attempt >= maxSelectModeAttempts) {
      return;
    }

    this.context.warn(`${reason} Refreshing the activity page before retrying.`);
    this.context.sortApplied = false;

    try {
      await this.context.page.reload({
        waitUntil: 'domcontentloaded',
        timeout: selectModeRefreshTimeoutMs,
      });
    } catch (error) {
      this.context.warn(
        `Page refresh did not settle cleanly: ${error instanceof Error ? error.message : String(error)}`,
      );
      await this.context.page.goto(this.context.target.url, {
        waitUntil: 'domcontentloaded',
        timeout: selectModeRefreshTimeoutMs,
      });
    }

    await waitForDomReady(this.context.page, selectModeRefreshTimeoutMs);
    await waitForPageIdle(this.context.page, 10_000, 1_000);
  }

  private async applyOldestToNewestSort(): Promise<boolean> {
    if (this.context.hasAppliedSortOnce) {
      this.context.info('Re-applying sort after recovery.');
    } else {
      this.context.info('Applying sort: Oldest to newest.');
    }

    const sortFilterLabels = uniqueStrings(getTranslationValues(this.context.translations, ['sortFilter', 'filter']));
    const oldestLabels = uniqueStrings(getTranslationValues(this.context.translations, ['oldestToNewest']));
    const applyLabels = uniqueStrings(getTranslationValues(this.context.translations, ['apply', 'done']));

    // 1. Open Sort & filter
    this.context.info('Opening Sort & filter.');
    const btnCoords = await this.findElementCoordinates(sortFilterLabels);
    if (!btnCoords) {
      this.context.warn('The Sort & filter button was not found.');
      return false;
    }

    await this.context.page.mouse.click(btnCoords.x, btnCoords.y);
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // 2. Locate Oldest to newest
    const oldestCoords = await this.findElementCoordinates(oldestLabels);
    if (!oldestCoords) {
      this.context.warn('The Oldest to newest option was not found.');
      return false;
    }
    this.context.info('Found Oldest to newest control.');

    // 3. Click Oldest to newest
    this.context.info('Clicking Oldest to newest.');
    await this.context.page.mouse.click(oldestCoords.x, oldestCoords.y);
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // 4. Verify selected state
    this.context.info('Verifying selected state.');
    const selectedState = await this.verifyOldestSelectedState(oldestLabels);
    const isSelected = selectedState ? selectedState.isSelected : false;
    this.context.info(`Oldest to newest selected: ${isSelected}.`);

    if (!isSelected) {
      this.context.warn('ERROR: Oldest to newest was not selected. Aborting before any selection/deletion.');
      return false;
    }

    // 5. Click Apply
    this.context.info('Applying sort.');
    const applyCoords = await this.findElementCoordinates(applyLabels);
    if (!applyCoords) {
      this.context.warn('The Sort & filter Apply button was not found.');
      return false;
    }

    await this.context.page.mouse.click(applyCoords.x, applyCoords.y);
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // 6. Verify modal is closed
    const isClosed = !(await this.isApplyButtonVisible(applyLabels));
    if (!isClosed) {
      this.context.warn('The Sort & filter modal did not close after clicking Apply.');
      return false;
    }

    await waitForPageIdle(this.context.page, 10_000, 1_000);
    this.context.info('Sort applied successfully.');
    this.context.hasAppliedSortOnce = true;
    return true;
  }

  private async findElementCoordinates(labels: string[]): Promise<{ x: number; y: number } | null> {
    return this.context.page.evaluate((labelsToFind) => {
      const candidates = Array.from(
        document.querySelectorAll('button, [role="button"], a, [tabindex="0"], [aria-label], div, span'),
      );

      const found = candidates.find((el) => {
        const ariaLabel = (el.getAttribute('aria-label') || '').trim().toLowerCase();
        const text = ((el as any).innerText || el.textContent || '').trim().toLowerCase();
        return labelsToFind.some((label) => {
          const normLabel = label.toLowerCase();
          return ariaLabel === normLabel || text === normLabel;
        });
      });

      if (!found) return null;

      const clickable = found.closest('[role="button"]') || found;
      const rect = clickable.getBoundingClientRect();
      return {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      };
    }, labels);
  }

  private async verifyOldestSelectedState(
    labels: string[],
  ): Promise<{ isSelected: boolean; backgroundColor: string; pointerEvents: string } | null> {
    return this.context.page.evaluate((labelsToFind) => {
      const candidates = Array.from(
        document.querySelectorAll('[role="button"], button, [aria-label], div, span'),
      );
      const found = candidates.find((el) => {
        const ariaLabel = (el.getAttribute('aria-label') || '').trim().toLowerCase();
        const text = ((el as any).innerText || el.textContent || '').trim().toLowerCase();
        return labelsToFind.some((label) => {
          const normLabel = label.toLowerCase();
          return ariaLabel === normLabel || text === normLabel;
        });
      });

      if (!found) return null;

      const clickable = found.closest('[role="button"]') || found;
      const style = window.getComputedStyle(clickable);

      const backgroundColor = style.backgroundColor;
      const pointerEvents = style.pointerEvents;

      // Selected state is characterized by white background (rgb(255, 255, 255))
      // or pointer-events: none on the clickable element
      const isSelected = backgroundColor === 'rgb(255, 255, 255)' || pointerEvents === 'none';

      return {
        isSelected,
        backgroundColor,
        pointerEvents,
      };
    }, labels);
  }

  private async isApplyButtonVisible(labels: string[]): Promise<boolean> {
    return this.context.page.evaluate((labelsToFind) => {
      const candidates = Array.from(
        document.querySelectorAll('[role="button"], button, [aria-label], div, span'),
      );
      const found = candidates.find((el) => {
        const ariaLabel = (el.getAttribute('aria-label') || '').trim().toLowerCase();
        const text = ((el as any).innerText || el.textContent || '').trim().toLowerCase();
        return labelsToFind.some((label) => {
          const normLabel = label.toLowerCase();
          return ariaLabel === normLabel || text === normLabel;
        });
      });

      if (!found) return false;

      const clickable = found.closest('[role="button"]') || found;
      const rect = clickable.getBoundingClientRect();
      const style = window.getComputedStyle(clickable);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    }, labels);
  }

  private async deactivateSelectionMode(): Promise<void> {
    const cancelLabels = uniqueStrings(getTranslationValues(this.context.translations, ['cancel']));
    await clickByLabels(this.context.page, cancelLabels, {
      timeout: 5000,
      exact: true,
      debugName: 'Cancel selection mode',
    });
    await waitForPageIdle(this.context.page, 3000, 500);
  }
}
