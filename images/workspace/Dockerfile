# The workspace server one person's agents run in. Build it with build.sh beside
# this file, which downloads and checks the pinned tools this copies in.
FROM ubuntu:24.04

# Squid runs as the egress proxy, from this same image, beside the workspaces.
RUN apt-get update \
  && apt-get install --yes --no-install-recommends \
    ca-certificates git gh openssh-client ripgrep procps squid \
  && rm -rf /var/lib/apt/lists/*

# Ubuntu ships a user 1000; the person works as their own ordinary user instead.
RUN userdel --remove ubuntu \
  && useradd --uid 1000 --create-home --home-dir /home/codenine --shell /bin/bash codenine

COPY opt/ /opt/

ENV PATH=/opt/codenine:/opt/claude/bin:/opt/codex/bin:/opt/node/bin:/usr/local/bin:/usr/bin:/bin \
  CODENINE_HOME=/home/codenine/.codenine

# The control server runs this with a read-only root filesystem: the person's
# volume at /home/codenine and /tmp are the only writable places.
USER 1000:1000
WORKDIR /home/codenine
EXPOSE 3773
ENTRYPOINT ["codenine", "serve", "--mode", "managed", "--host", "0.0.0.0", "--port", "3773", "--no-browser"]
