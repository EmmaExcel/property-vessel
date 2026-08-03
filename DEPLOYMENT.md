# Private free cloud deployment

This deployment keeps Property Vessel private while moving the always-on
runtime away from the local Mac:

```text
Your Tailscale devices -> Tailscale Serve -> Oracle VM -> Docker scraper
                                                        -> MongoDB Atlas
                                                        -> AI provider
```

## 1. Create the free VM

In Oracle Cloud, create an **Always Free eligible** Ubuntu instance. Prefer an
Ampere A1 Flex shape with 2 OCPUs and at least 8 GB RAM; Chromium is unreliable
on the much smaller 1 GB micro shape. Save the generated private SSH key.

The VM needs outbound internet access. Only SSH needs to be reachable for
initial administration; ports 80, 443, and 3000 do not need to be publicly
opened because Tailscale supplies private ingress.

## 2. Copy the project to the VM

From the Mac, substitute the downloaded key and Oracle VM public IP:

```bash
chmod 600 /path/to/oracle-private-key
rsync -az --exclude node_modules --exclude .env \
  -e "ssh -i /path/to/oracle-private-key" \
  /path/to/PV-v1/ ubuntu@VM_PUBLIC_IP:~/property-vessel/
scp -i /path/to/oracle-private-key /path/to/PV-v1/.env \
  ubuntu@VM_PUBLIC_IP:~/property-vessel/.env
ssh -i /path/to/oracle-private-key ubuntu@VM_PUBLIC_IP
```

The `.env` transfer is encrypted by SSH. Never put it in source control.

## 3. Install Docker and start the scraper

On the VM, install Docker Engine and the Compose plugin from Docker's official
Ubuntu repository, then allow the `ubuntu` user to run Docker. Log out and back
in after adding the group:

```bash
sudo usermod -aG docker ubuntu
```

Start and verify the application:

```bash
cd ~/property-vessel
chmod 600 .env
docker compose up -d --build
docker compose ps
curl http://127.0.0.1:3000/api/health
```

The Compose service restarts after VM reboots and binds the dashboard only to
the VM's loopback interface.

## 4. Add the VM to the private Tailscale network

Install Tailscale on the VM and authenticate it with the same personal account
used by the phone/laptop:

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
sudo tailscale serve --bg --https=443 http://127.0.0.1:3000
tailscale serve status
```

Tailscale prints the private `https://...ts.net` address. Only authorized
devices in the tailnet can reach it. Do not use `tailscale funnel`, because
Funnel makes the service public.

## 5. Final checks

Open the private address from another Tailscale device and run a small one-page
scrape. Confirm:

- `/api/storage` reports `mongodb`.
- The run finishes after closing the browser tab.
- Raw JSON, platform JSON, and the report download successfully.
- The records appear in the Atlas `property_vessel` database.

For updates, copy the changed project files and run:

```bash
docker compose up -d --build
```
