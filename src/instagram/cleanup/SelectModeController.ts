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

      await this.context.page
        .waitForFunction(
          (labels: string[]) => {
            const candidates = Array.from(
              document.querySelectorAll('button, [role="button"], a, [tabindex="0"], [aria-label], div, span'),
            );
            return candidates.some((el) => {
              const text = ((el as any).innerText || el.textContent || '').trim().toLowerCase();
              const aria = (el.getAttribute('aria-label') || '').trim().toLowerCase();
              return labels.some((lbl) => text === lbl.toLowerCase() || aria === lbl.toLowerCase());
            });
          },
          { timeout: 5000, polling: 50 },
          this.context.target.selectLabels,
        )
        .catch(() => {});

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
      this.context.info('Reapplying sort: Oldest to newest.');
    } else {
      this.context.info('Applying sort: Oldest to newest.');
    }

    const sortFilterLabels = uniqueStrings(getTranslationValues(this.context.translations, ['sortFilter', 'filter']));
    const oldestLabels = uniqueStrings(getTranslationValues(this.context.translations, ['oldestToNewest']));
    const applyLabels = uniqueStrings(getTranslationValues(this.context.translations, ['apply', 'done']));

    // 1. Open Sort & filter
    this.context.info('Opening Sort & filter.');
    let btnCoords = await this.findElementCoordinates(sortFilterLabels);
    if (!btnCoords) {
      try {
        await this.context.page.waitForFunction(
          (labels: string[]) => {
            const candidates = Array.from(
              document.querySelectorAll('button, [role="button"], a, [tabindex="0"], [aria-label], div, span'),
            );
            return candidates.some((el) => {
              const ariaLabel = (el.getAttribute('aria-label') || '').trim().toLowerCase();
              const text = ((el as any).innerText || el.textContent || '').trim().toLowerCase();
              return labels.some((label) => {
                const normLabel = label.toLowerCase();
                return ariaLabel === normLabel || text === normLabel;
              });
            });
          },
          { timeout: 3000, polling: 50 },
          sortFilterLabels,
        );
        btnCoords = await this.findElementCoordinates(sortFilterLabels);
      } catch {
        this.context.warn('The Sort & filter button was not found.');
        return false;
      }
    }

    if (!btnCoords) {
      this.context.warn('The Sort & filter button was not found.');
      return false;
    }

    await this.context.page.mouse.click(btnCoords.x, btnCoords.y);

    // 2. Locate Oldest to newest (fast DOM polling)
    let oldestCoords: { x: number; y: number } | null = null;
    try {
      await this.context.page.waitForFunction(
        (labels: string[]) => {
          const candidates = Array.from(
            document.querySelectorAll('button, [role="button"], a, [tabindex="0"], [aria-label], div, span'),
          );
          return candidates.some((el) => {
            const ariaLabel = (el.getAttribute('aria-label') || '').trim().toLowerCase();
            const text = ((el as any).innerText || el.textContent || '').trim().toLowerCase();
            return labels.some((label) => {
              const normLabel = label.toLowerCase();
              return ariaLabel === normLabel || text === normLabel;
            });
          });
        },
        { timeout: 3000, polling: 50 },
        oldestLabels,
      );
      oldestCoords = await this.findElementCoordinates(oldestLabels);
    } catch {
      this.context.warn('The Oldest to newest option was not found.');
      return false;
    }

    if (!oldestCoords) {
      this.context.warn('The Oldest to newest option was not found.');
      return false;
    }
    this.context.info('Found Oldest to newest control.');

    // 3. Click Oldest to newest
    this.context.info('Clicking Oldest to newest.');
    await this.context.page.mouse.click(oldestCoords.x, oldestCoords.y);

    // 4. Set Start Date: April 2024
    this.context.info('Setting Start Date: April 2024.');
    const dateSet = await this.context.page.evaluate(() => {
      const selects = Array.from(document.querySelectorAll('select'));
      const dateSelects = selects.filter((s) => s.getAttribute('aria-label') !== 'Switch Display Language');
      if (dateSelects.length < 3) return false;

      const monthSelect = dateSelects[0] as HTMLSelectElement;
      const yearSelect = dateSelects[2] as HTMLSelectElement;

      function setSelectValue(selectEl: HTMLSelectElement, targetValueOrText: string) {
        const options = Array.from(selectEl.options);
        const match = options.find((opt) => {
          const text = (opt.textContent || '').trim().toLowerCase();
          const val = opt.value.trim().toLowerCase();
          const norm = targetValueOrText.toLowerCase();
          return text === norm || val === norm;
        });

        if (!match) return false;

        selectEl.value = match.value;
        selectEl.dispatchEvent(new Event('change', { bubbles: true }));
        selectEl.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      }

      const monthSet = setSelectValue(monthSelect, 'April') || setSelectValue(monthSelect, '4');
      const yearSet = setSelectValue(yearSelect, '2024');

      return monthSet && yearSet;
    });

    if (!dateSet) {
      this.context.warn('Could not set Start Date to April 2024.');
      return false;
    }

    // 5. Verify both Oldest to newest AND Start Date April 2024 are selected
    this.context.info('Verifying sort and date filter selections.');
    const selectionVerified = await this.context.page.evaluate((labels: string[]) => {
      // a. Verify Oldest to newest
      const candidates = Array.from(document.querySelectorAll('[role="button"], button, [aria-label], div, span'));
      const found = candidates.find((el) => {
        const ariaLabel = (el.getAttribute('aria-label') || '').trim().toLowerCase();
        const text = ((el as any).innerText || el.textContent || '').trim().toLowerCase();
        return labels.some((label) => {
          const normLabel = label.toLowerCase();
          return ariaLabel === normLabel || text === normLabel;
        });
      });
      let oldestOk = false;
      if (found) {
        const clickable = found.closest('[role="button"]') || found;
        const style = window.getComputedStyle(clickable);
        oldestOk = style.backgroundColor === 'rgb(255, 255, 255)' || style.pointerEvents === 'none';
      }

      // b. Verify Start Date April 2024
      const selects = Array.from(document.querySelectorAll('select'));
      const dateSelects = selects.filter((s) => s.getAttribute('aria-label') !== 'Switch Display Language');
      if (dateSelects.length < 3) return { oldest: oldestOk, date: false };

      const monthSelect = dateSelects[0] as HTMLSelectElement;
      const yearSelect = dateSelects[2] as HTMLSelectElement;

      const curMonthText = monthSelect.options[monthSelect.selectedIndex]?.textContent?.trim().toLowerCase() || '';
      const curYearText = yearSelect.options[yearSelect.selectedIndex]?.textContent?.trim() || '';

      const monthOk = curMonthText === 'april' || monthSelect.value === '4';
      const yearOk = curYearText === '2024' || yearSelect.value === '2024';

      return { oldest: oldestOk, date: monthOk && yearOk };
    }, oldestLabels);

    this.context.info(
      `Selection verification - Oldest to newest: ${selectionVerified.oldest}, Start Date April 2024: ${selectionVerified.date}.`,
    );

    if (!selectionVerified.oldest || !selectionVerified.date) {
      this.context.warn(
        'ERROR: Verification failed before Apply. Oldest to newest or April 2024 was not selected. Aborting.',
      );
      return false;
    }

    // 6. Click Apply (wait until button is actually visible and enabled)
    this.context.info('Applying sort.');
    try {
      await this.context.page.waitForFunction(
        (labels: string[]) => {
          const candidates = Array.from(
            document.querySelectorAll('[role="button"], button, [aria-label], div, span'),
          );
          const found = candidates.find((el) => {
            const ariaLabel = (el.getAttribute('aria-label') || '').trim().toLowerCase();
            const text = ((el as any).innerText || el.textContent || '').trim().toLowerCase();
            return labels.some((label) => {
              const normLabel = label.toLowerCase();
              return ariaLabel === normLabel || text === normLabel;
            });
          });
          if (!found) return false;
          const clickable = found.closest('[role="button"]') || found;
          const rect = clickable.getBoundingClientRect();
          const style = window.getComputedStyle(clickable);
          const isDisabled = (clickable as any).disabled || clickable.getAttribute('aria-disabled') === 'true';
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            style.pointerEvents !== 'none' &&
            !isDisabled
          );
        },
        { timeout: 5000, polling: 50 },
        applyLabels,
      );
    } catch {
      // Proceed to attempt finding coordinates
    }

    const applyCoords = await this.findElementCoordinates(applyLabels);
    if (!applyCoords) {
      this.context.warn('The Sort & filter Apply button was not found.');
      return false;
    }

    await this.context.page.mouse.click(applyCoords.x, applyCoords.y);

    // 6. Verify modal is closed immediately via DOM polling
    try {
      await this.context.page.waitForFunction(
        (labels: string[]) => {
          const candidates = Array.from(
            document.querySelectorAll('[role="button"], button, [aria-label], div, span'),
          );
          const found = candidates.find((el) => {
            const ariaLabel = (el.getAttribute('aria-label') || '').trim().toLowerCase();
            const text = ((el as any).innerText || el.textContent || '').trim().toLowerCase();
            return labels.some((label) => {
              const normLabel = label.toLowerCase();
              return ariaLabel === normLabel || text === normLabel;
            });
          });
          if (!found) return true;
          const clickable = found.closest('[role="button"]') || found;
          const rect = clickable.getBoundingClientRect();
          const style = window.getComputedStyle(clickable);
          return rect.width === 0 || rect.height === 0 || style.display === 'none' || style.visibility === 'hidden';
        },
        { timeout: 3000, polling: 50 },
        applyLabels,
      );
    } catch {
      const isClosed = !(await this.isApplyButtonVisible(applyLabels));
      if (!isClosed) {
        this.context.warn('The Sort & filter modal did not close after clicking Apply.');
        return false;
      }
    }

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
