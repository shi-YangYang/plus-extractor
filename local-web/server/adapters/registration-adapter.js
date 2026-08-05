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
    this.registrationClient = Object.hasOwn(options, "registrationClient")
      ? options.registrationClient
      : options.registrationDriver || null;
    this.identityFactory = options.identityFactory || generateRegistrationIdentity;
  }

  describe() {
    return {
      key: "registration",
      label: "iCloud email registration",
      status: this.registrationClient ? "ready" : "mailbox_reader_ready",
      ready: Boolean(this.registrationClient),
      proxyRegion: "US",
      capabilities: {
        mailboxProbe: true,
        verificationCodePolling: true,
        protocolRegistration: Boolean(this.registrationClient),
        browserFormAutomation: false,
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

  async execute({ taskId, proxy, registration, reportProgress } = {}) {
    const config = normalizeRegistrationInput(registration || {}, { identityFactory: this.identityFactory });
    if (!this.registrationClient) {
      throw pendingAdapter(
        "REGISTRATION_PROTOCOL_CLIENT_PENDING",
        "Mailbox code reader is ready; the ChatGPT registration protocol client is the next registration component."
      );
    }

    return this.registrationClient.register({
      taskId,
      email: config.email,
      identity: config.identity,
      proxy,
      reportProgress,
      readVerificationSnapshot: (options = {}) => this.mailboxReader.fetchSnapshot({
        ...config,
        proxy,
        ...options
      }),
      waitForVerificationCode: (options = {}) => this.mailboxReader.waitForCode({
        ...config,
        proxy,
        ...options
      })
    });
  }
}

module.exports = { RegistrationAdapter, normalizeRegistrationInput };
