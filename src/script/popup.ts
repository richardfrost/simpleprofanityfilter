import Constants from '@APF/lib/constants';
import { dynamicList } from '@APF/lib/helper';
import WebConfig from '@APF/webConfig';
import Domain from '@APF/domain';
import Page from '@APF/page';
import Logger from '@APF/lib/logger';
import i18next from 'i18next';
import i18nextHttpBackend from 'i18next-http-backend';
const logger = new Logger('Popup');

export default class Popup {
  cfg: WebConfig;
  disabledTab: boolean;
  domain: Domain;
  filterToggleProp: string;
  prefersDarkScheme: boolean;
  protected: boolean;
  status: number;
  summaries: { number?: Summary };
  tab: chrome.tabs.Tab;
  themeElements: Element[];
  url: URL;
  webFilterActive: boolean;

  //#region Class reference helpers
  // Can be overridden in children classes
  static get Config() { return WebConfig; }
  static get Constants() { return Constants; }
  static get Domain() { return Domain; }
  static get Page() { return Page; }
  get Class() { return (this.constructor as typeof Popup); }
  //#endregion

  static readonly _requiredConfig = [
    'darkMode',
    'domains',
    'enabledDomainsOnly',
    'filterMethod',
    'loggingLevel',
    'password',
    'wordlistId',
    'wordlists',
    'wordlistsEnabled',
  ];

  static applyTranslation(language = null) {
    i18next.use(i18nextHttpBackend).init({
      lng: language?.split('-')[0] || navigator.language.split('-')[0],
      fallbackLng: 'en',
      backend: {
        loadPath: 'locales/{{lng}}/translation.json'
      }
    }, function (err, t) {
      if (err) {
        logger.error('Failed to load translations:', err);
        return;
      }

      // Initialize the UI with the translated text
      document.getElementById('domainModeLabel').textContent = i18next.t('domainModeLabel');
      document.getElementById('filterMethodLabel').textContent = i18next.t('filterMethodLabel');
      document.getElementById('textWordlistLabel').textContent = i18next.t('textWordlistLabel');
    });
  }

  static disable(element) {
    element.disabled = true;
    element.classList.add('disabled');
  }

  static enable(element) {
    element.disabled = false;
    element.classList.remove('disabled');
  }

  static hide(element: HTMLElement) {
    element.classList.remove('w3-show');
    element.classList.add('w3-hide');
  }

  static async load(instance: Popup) {
    instance.cfg = await this.Config.load(this._requiredConfig);
    logger.setLevel(instance.cfg.loggingLevel);
    instance.tab = await this.Domain.getCurrentTab() as chrome.tabs.Tab;
    if (instance.tab.url) {
      instance.url = new URL(instance.tab.url);
      instance.domain = this.Domain.byHostname(instance.url.hostname, instance.cfg.domains);
    } else { // No URL
      instance.url = null;
      instance.domain = new this.Domain('');
    }
    instance.filterToggleProp = instance.cfg.enabledDomainsOnly ? 'enabled' : 'disabled';

    // Request current tab status
    const statusMessage: Message = {
      source: this.Constants.MESSAGING.POPUP,
      destination: this.Constants.MESSAGING.BACKGROUND,
      getStatus: true,
      tabId: instance.tab.id,
    };
    chrome.runtime.sendMessage(statusMessage, (response) => {
      instance.updateStatus(response.status);
    });

    return instance;
  }

  static show(element: HTMLElement) {
    element.classList.remove('w3-hide');
    element.classList.add('w3-show');
  }

  constructor() {
    this.webFilterActive = true;
    this.initializeMessaging();
    this.disabledTab = false;
    this.prefersDarkScheme = window.matchMedia('(prefers-color-scheme: dark)').matches;
    this.protected = false;
    this.summaries = {};
    this.themeElements = [document.body, document.querySelector('#footer')];
  }

  applyDarkTheme() {
    document.documentElement.style.setProperty('color-scheme', 'dark');
    const summaryTable = document.querySelector('#summary > table') as HTMLTableElement;
    summaryTable.classList.remove('w3-striped');
    this.themeElements.forEach((element) => {
      element.classList.add('dark');
      element.classList.remove('light');
    });
  }

  applyLightTheme() {
    document.documentElement.style.setProperty('color-scheme', 'light');
    const summaryTable = document.querySelector('#summary > table') as HTMLTableElement;
    summaryTable.classList.add('w3-striped');
    this.themeElements.forEach((element) => {
      element.classList.remove('dark');
      element.classList.add('light');
    });
  }

  applyTheme() {
    if (this.cfg.darkMode == null) {
      this.prefersDarkScheme ? this.applyDarkTheme() : this.applyLightTheme();
    } else {
      this.cfg.darkMode ?  this.applyDarkTheme() : this.applyLightTheme();
    }
  }

  disableDomainSwitch() {
    const domainFilter = document.getElementById('domainFilter') as HTMLInputElement;
    const domainToggle = document.getElementById('domainToggle') as HTMLInputElement;
    this.Class.disable(domainFilter);
    this.Class.disable(domainToggle);
  }

  get disabledReason(): string {
    if (this.isRestrictedPage) return i18next.t('popupDisabledRestrictedPage');
    if (this.isPasswordProtected) return i18next.t('popupDisabledPasswordProtected');
    if (this.disabledTab) return i18next.t('popupDisabledTab');
    if (this.cfg.enabledDomainsOnly && !this.domain.enabled) return i18next.t('popupDisabledDomainMode');
    if (this.domain.disabled) return i18next.t('popupDisabledDomain');
    if (this.isDisconnected) return i18next.t('popupDisabledDisconnected');
    return '';
  }

  disableOptions() {
    const domainModeSelect = document.getElementById('domainModeSelect') as HTMLSelectElement;
    const filterMethodSelect = document.getElementById('filterMethodSelect') as HTMLSelectElement;
    const wordlistSelect = document.getElementById('wordlistSelect') as HTMLSelectElement;
    this.Class.disable(domainModeSelect);
    this.Class.disable(filterMethodSelect);
    this.Class.disable(wordlistSelect);
  }

  enableOptions() {
    const domainModeSelect = document.getElementById('domainModeSelect') as HTMLSelectElement;
    const filterMethodSelect = document.getElementById('filterMethodSelect') as HTMLSelectElement;
    const wordlistSelect = document.getElementById('wordlistSelect') as HTMLSelectElement;
    this.Class.enable(domainModeSelect);
    this.Class.enable(filterMethodSelect);
    this.Class.enable(wordlistSelect);
  }

  async filterMethodSelect() {
    const filterMethodSelect = document.getElementById('filterMethodSelect') as HTMLSelectElement;
    this.cfg.filterMethod = filterMethodSelect.selectedIndex;
    try {
      await this.cfg.save('filterMethod');
      chrome.tabs.reload();
      this.populateOptions();
    } catch (err) {
      logger.error('Failed to update selected filter method.', err);
    }
  }

  getBackgroundData(): Promise<BackgroundData> {
    return new Promise((resolve, reject) => {
      const message = {
        destination: this.Class.Constants.MESSAGING.BACKGROUND,
        source: this.Class.Constants.MESSAGING.POPUP,
        backgroundData: true,
        tabId: this.tab.id,
      };
      chrome.runtime.sendMessage(message, (response) => {
        if (!response) { response = { disabledTab: false }; }
        resolve(response);
      });
    });
  }

  handleDisabled() {
    this.setDomainSwitch(false);
    this.disableOptions();
  }

  handleDisabledMessage() {
    const element = document.querySelector('#disabledMessage') as HTMLElement;
    element.textContent = this.disabledReason;
    this.isDisabled ? this.Class.show(element) : this.Class.hide(element);
  }

  handleEnabled() {
    this.setDomainSwitch(true);
    this.enableOptions();
  }

  handlePasswordProtected() {
    this.protected = true;
    this.disableDomainSwitch();
    this.disableOptions();
  }

  handleRestrictedPage() {
    this.setDomainSwitch(false);
    this.disableDomainSwitch();
    this.disableOptions();
  }

  handleSummaryMessage(frameId: number, summary: Summary) {
    if (Object.keys(summary).length) {
      this.updateSummaries(frameId, summary);
      this.populateSummary();
    }
  }

  handleWordlistsEnabled() {
    const wordListContainer = document.getElementById('wordListContainer') as HTMLInputElement;
    const wordlistSelect = document.getElementById('wordlistSelect') as HTMLSelectElement;
    const wordlists = ['Default Wordlist'].concat(this.Class.Config._allWordlists, this.cfg.wordlists);
    const wordlistIndex = this.domain.wordlistId >= 0 ? this.domain.wordlistId + 1 : 0;
    dynamicList(wordlists, wordlistSelect);
    wordlistSelect.selectedIndex = wordlistIndex;
    this.Class.show(wordListContainer);
  }

  initializeMessaging() {
    chrome.runtime.onMessage.addListener((request: Message, sender, sendResponse) => {
      if (request.destination !== this.Class.Constants.MESSAGING.POPUP) return true;

      if (request.summary) {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          if (sender.tab.id == tabs[0].id) this.handleSummaryMessage(sender.frameId, request.summary);
        });
      } else if (request.status) {
        this.updateStatus(request.status);
      } else {
        logger.error('Received unhandled message.', JSON.stringify(request));
      }

      sendResponse(); // Issue 393 - Chrome 99+ promisified sendMessage expects callback to be called
    });

    // Initial data request
    const message = { destination: this.Class.Constants.MESSAGING.CONTEXT, source: this.Class.Constants.MESSAGING.POPUP, summary: true };
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      chrome.tabs.sendMessage(tabs[0].id, message, () => {
        if (chrome.runtime.lastError) this.webFilterActive = false;
      });
    });
  }

  async initializePopup() {
    await this.Class.load(this);
    this.applyTheme();
    this.populateOptions(true);
  }

  get isDisconnected() {
    return (
      false // Disable for now because its not stable and can break when toggling
      && !this.webFilterActive
      && !this.disabledTab
      && !this.isRestrictedPage
      && !this.domain.disabled
      && !(this.cfg.enabledDomainsOnly && !this.domain.enabled)
    );
  }

  get isDisabled() {
    return (
      this.domain.disabled
      || this.disabledTab
      || (this.cfg.enabledDomainsOnly && !this.domain.enabled)
      || this.isRestrictedPage
      || this.isPasswordProtected
      || this.isDisconnected
    );
  }

  get isPasswordProtected() {
    return this.cfg.password && this.cfg.password != '';
  }

  get isRestrictedPage() {
    return (
      !this.domain.hostname
      || this.Class.Page.disabledProtocols.test(this.url.protocol)
      || (
        this.Class.Config.BUILD.target == this.Class.Constants.BUILD_TARGET_CHROME
        && this.Class.Page.disabledChromePages.includes(this.domain.hostname)
      )
      || (
        this.Class.Config.BUILD.target == this.Class.Constants.BUILD_TARGET_FIREFOX
        && this.Class.Page.disabledFirefoxPages.includes(this.domain.hostname)
      )
    );
  }

  async populateOptions(init = false) {
    const domainModeSelect = document.getElementById('domainModeSelect') as HTMLSelectElement;
    const filterMethodSelect = document.getElementById('filterMethodSelect') as HTMLSelectElement;
    dynamicList(this.Class.Constants.orderedArray(this.Class.Constants.DOMAIN_MODES), domainModeSelect, true);
    domainModeSelect.selectedIndex = this.domain.getModeIndex();
    dynamicList(this.Class.Constants.orderedArray(this.Class.Constants.FILTER_METHODS), filterMethodSelect, true);
    filterMethodSelect.selectedIndex = this.cfg.filterMethod;

    if (init) {
      const backgroundData = await this.getBackgroundData();
      this.disabledTab = backgroundData.disabledTab;
    } else {
      this.updateStatus(null);
      this.summaries = {};
      this.populateSummary();
    }

    if (this.wordlistsEnabled) this.handleWordlistsEnabled();

    this.handleDisabledMessage();

    if (this.isRestrictedPage || this.isDisconnected) {
      this.handleRestrictedPage();
      return false;
    }

    if (this.isPasswordProtected) {
      this.handlePasswordProtected();
      return false;
    }

    // Set initial value for domain filter and disable options if they are not applicable
    this.isDisabled ? this.handleDisabled() : this.handleEnabled();
  }

  populateSummary() {
    const summaryContainer = document.getElementById('summary') as HTMLDivElement;
    const table = summaryContainer.querySelector('table') as HTMLTableElement;
    const oldTBody = table.tBodies[0];
    const tBody = document.createElement('tbody');
    const summary = this.summary;
    const sortedKeys = Object.keys(summary).sort((a, b) => summary[b].count - summary[a].count);

    if (sortedKeys.length) {
      for (const key of sortedKeys) {
        const row = tBody.insertRow();
        const wordCell = row.insertCell(0);
        wordCell.classList.add('w3-tooltip');
        const tooltipSpan = document.createElement('span');
        tooltipSpan.classList.add('summaryTooltip', 'w3-tag', 'w3-text');
        tooltipSpan.textContent = key;
        const wordSpan = document.createElement('span');
        wordSpan.textContent = summary[key].filtered;
        wordCell.appendChild(tooltipSpan);
        wordCell.appendChild(wordSpan);

        const countCell = row.insertCell(1);
        countCell.classList.add('w3-right');
        countCell.textContent = summary[key].count.toString();
      }

      summaryContainer.classList.remove('w3-hide');
    } else {
      summaryContainer.classList.add('w3-hide');
    }
    table.replaceChild(tBody, oldTBody);
  }

  setDomainSwitch(checked: boolean = true) {
    const domainFilter = document.getElementById('domainFilter') as HTMLInputElement;
    domainFilter.checked = checked;
  }

  get summary(): Summary {
    const combined = {};
    for (const frameId of Object.keys(this.summaries)) {
      const frame = this.summaries[frameId];
      for (const wordKey of Object.keys(frame)) {
        const frameWord = frame[wordKey];
        if (!combined[wordKey]) combined[wordKey] = { count: 0, filtered: frameWord.filtered };
        combined[wordKey].count += frameWord.count;
      }
    }

    return combined;
  }

  async toggle(prop: string) {
    if (!this.protected) {
      try {
        if (this.disabledTab) {
          const message = {
            source: this.Class.Constants.MESSAGING.POPUP,
            destination: this.Class.Constants.MESSAGING.BACKGROUND,
            enableTab: true,
            tabId: this.tab.id,
          };
          this.disabledTab = await chrome.runtime.sendMessage(message);
        } else {
          this.domain[prop] = !this.domain[prop];
          await this.domain.save(this.cfg);
        }
        chrome.tabs.reload();
        this.populateOptions();
      } catch (err) {
        logger.error(`Failed to toggle domain '${this.domain.hostname}'.`, err);
      }
    }
  }

  async updateDomainMode() {
    if (!this.protected) {
      const domainModeSelect = document.getElementById('domainModeSelect') as HTMLSelectElement;
      this.domain.updateFromModeIndex(domainModeSelect.selectedIndex);
      try {
        await this.domain.save(this.cfg);
        chrome.tabs.reload();
        this.populateOptions();
      } catch (err) {
        logger.error(`Failed to update mode for domain '${this.domain.hostname}'.`, err);
      }
    }
  }

  updateStatus(status) {
    this.status = status;
    const container = document.getElementById('statusContainer');
    const statusText = document.getElementById('statusText');

    this.Class.hide(container);
    statusText.textContent = '';
  }

  updateSummaries(frameId: number, summary: Summary) {
    this.summaries[frameId] = summary;
  }

  async wordlistSelect(select: HTMLSelectElement) {
    const type = this.wordlistType(select);
    this.domain[type] = select.selectedIndex > 0 ? select.selectedIndex - 1 : undefined; // index 0 = use default (undefined)
    try {
      await this.domain.save(this.cfg);
      chrome.tabs.reload();
      this.populateOptions();
    } catch (err) {
      logger.error(`Failed to select wordlist for domain ${this.domain.hostname}.`, err);
    }
  }

  get wordlistsEnabled() {
    return !!this.cfg.wordlistsEnabled;
  }

  wordlistType(select: HTMLSelectElement): string {
    return select.id === 'wordlistSelect' ? 'wordlistId' : '';
  }
}
