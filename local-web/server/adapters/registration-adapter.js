"use strict";

const { pendingAdapter } = require("../lib/errors");
const {
  MailboxCodeReader,
  maskEmail,
  normalizeMailboxInput
} = require("../services/mailbox-code-reader");
const {
  generateRegistrationIdentity,
  normalizeRegistrationIdentity
} = require("../services/registration-identity");

function normalizeRegistrationInput(input = {}, options = {}) {
  const mailbox = normalizeMailboxInput(input);
  const suppliedIdentity = input.identity || (input.fullName && input.birthdate ? input : null);
  const identity = suppliedIdentity
    ? normalizeRegistrationIdentity(suppliedIdentity, options)
    : normalizeRegistrationIdentity((options.identityFactory || generateRegistrationIdentity)(), options);
  return Object.freeze({ ...mailbox, identity });
}

class RegistrationAdapter {
  constructor(options = {}) {
    this.mailboxReader = options.mailboxReader || new MailboxCodeReader(options);
    this.protocolRegistrationClient = Object.hasOwn(options, "protocolRegistrationClient")
      ? options.protocolRegistrationClient
      : Object.hasOwn(options, "registrationClient")
      ? options.registrationClient
      : options.registrationDriver || null;
    this.roxyRegistrationClient = options.roxyRegistrationClient || null;
    this.registrationClient = this.protocolRegistrationClient;
    this.identityFactory = options.identityFactory || generateRegistrationIdentity;
  }

  describe() {
    return {
      key: "registration",
      label: "iCloud email registration",
      status: this.protocolRegistrationClient || this.roxyRegistrationClient ? "ready" : "mailbox_reader_ready",
      ready: Boolean(this.protocolRegistrationClient || this.roxyRegistrationClient),
      proxyRegion: "REGISTRATION",
      capabilities: {
        mailboxProbe: true,
        verificationCodePolling: true,
        protocolRegistration: Boolean(this.protocolRegistrationClient),
        roxyBrowserRegistration: Boolean(this.roxyRegistrationClient),
        browserFormAutomation: Boolean(this.roxyRegistrationClient),
        automaticRoxyJpProxyAssignment: false,
        roxyUsesExistingProfileProxy: Boolean(this.roxyRegistrationClient),
        roxyProxySource: "existing_roxy_profile",
        accountsPerRoxyWindow: 2,
        generatedProfile: true
      }
    };
  }

  prepare(input = {}) {
    const config = normalizeRegistrationInput(input, { identityFactory: this.identityFactory });
    return {
      private: {
        email: config.email,
        inboxUrl: config.inboxUrl,
        identity: config.identity
      },
      public: {
        account: maskEmail(config.email),
        mailboxHost: config.mailboxHost,
        profile: { fullName: config.identity.fullName, age: config.identity.age }
      }
    };
  }

  async probe(input = {}) {
    return this.mailboxReader.probe(input);
  }

  registrationItem({ taskId, proxy, registration, reportProgress, signal } = {}) {
    const config = normalizeRegistrationInput(registration || {}, { identityFactory: this.identityFactory });
    return {
      taskId,
      email: config.email,
      identity: config.identity,
      proxy,
      reportProgress,
      signal,
      readVerificationSnapshot: (options = {}) => this.mailboxReader.fetchSnapshot({
        ...config,
        proxy,
        ...options,
        signal: options.signal || signal
      }),
      waitForVerificationCode: (options = {}) => this.mailboxReader.waitForCode({
        ...config,
        proxy,
        ...options,
        signal: options.signal || signal
      })
    };
  }

  async execute({ taskId, proxy, registration, registrationMode = "protocol", reportProgress, signal } = {}) {
    const mode = String(registrationMode || "protocol").trim().toLowerCase();
    const registrationClient = mode === "roxybrowser"
      ? this.roxyRegistrationClient
      : this.protocolRegistrationClient;
    if (!registrationClient) {
      throw pendingAdapter(
        mode === "roxybrowser" ? "ROXY_REGISTRATION_CLIENT_PENDING" : "REGISTRATION_PROTOCOL_CLIENT_PENDING",
        mode === "roxybrowser"
          ? "RoxyBrowser registration client is not initialized."
          : "Mailbox code reader is ready; the ChatGPT registration protocol client is the next registration component."
      );
    }
    return registrationClient.register(this.registrationItem({ taskId, proxy, registration, reportProgress, signal }));
  }

  supportsBatchMode(registrationMode = "protocol") {
    return registrationMode === "roxybrowser"
      && Boolean(this.roxyRegistrationClient && typeof this.roxyRegistrationClient.registerBatch === "function");
  }

  async executeBatch({ items = [], registrationMode = "protocol" } = {}) {
    if (!this.supportsBatchMode(registrationMode)) {
      throw pendingAdapter("REGISTRATION_BATCH_MODE_PENDING", `Batch registration mode ${registrationMode} is not initialized.`);
    }
    return this.roxyRegistrationClient.registerBatch({
      items: items.map((item) => this.registrationItem(item))
    });
  }
}

module.exports = { RegistrationAdapter, normalizeRegistrationInput };
