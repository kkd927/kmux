FROM debian:bookworm-slim@sha256:7b140f374b289a7c2befc338f42ebe6441b7ea838a042bbd5acbfca6ec875818

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      bash \
      ca-certificates \
      dash \
      fish \
      git \
      iproute2 \
      openssh-client \
      openssh-server \
      procps \
      socat \
      tini \
      zsh \
    && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --uid 1000 --shell /bin/bash kmux \
    && useradd --create-home --uid 1001 --shell /bin/zsh kmux-alt \
    && printf 'kmux:kmux-password\nkmux-alt:kmux-alt-password\n' | chpasswd \
    && mkdir -p /etc/ssh/authorized_keys /opt/kmux-fixtures/repository /opt/kmux-runtime \
    && git init --initial-branch=main /opt/kmux-fixtures/repository \
    && git -C /opt/kmux-fixtures/repository config user.name 'kmux fixture' \
    && git -C /opt/kmux-fixtures/repository config user.email 'fixture@kmux.invalid' \
    && printf 'fixture\n' > /opt/kmux-fixtures/repository/README.md \
    && git -C /opt/kmux-fixtures/repository add README.md \
    && GIT_AUTHOR_DATE='2000-01-01T00:00:00Z' \
      GIT_COMMITTER_DATE='2000-01-01T00:00:00Z' \
      git -C /opt/kmux-fixtures/repository commit -m 'fixture root' \
    && chown -R kmux:kmux /opt/kmux-fixtures/repository

COPY sshd_config /etc/ssh/sshd_config
COPY entrypoint.sh /usr/local/sbin/kmux-sshd-entrypoint

RUN chmod 0755 /usr/local/sbin/kmux-sshd-entrypoint \
    && chmod 0600 /etc/ssh/sshd_config

EXPOSE 22

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/sbin/kmux-sshd-entrypoint"]
