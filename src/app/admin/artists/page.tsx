import {CatalogueList} from "@/components/catalogue-list";
export default async function Page({searchParams}:PageProps<"/admin/artists">) {return <CatalogueList kind="artists" params={await searchParams}/>;}
